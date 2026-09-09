"""Explicitly shared reports, reviewed using current room moderator authority.

Platform-only reports and platform notes never enter this projection. A separate
review row prevents delegated moderation from overwriting private admin reviews.
"""
import re
import time
from urllib.parse import quote
from aiohttp import web

try:
    from .server import APIError, body_json, text_value
    from .room_authority import room_authority, room_id, user_id, content
except ImportError:
    from server import APIError, body_json, text_value
    from room_authority import room_authority, room_id, user_id, content

STATUSES = frozenset({'open', 'reviewing', 'resolved', 'dismissed'})


def schema(store):
    columns = {row[1] for row in store.db.execute('PRAGMA table_info(reports)')}
    if 'audience' not in columns:
        store.db.execute("ALTER TABLE reports ADD COLUMN audience TEXT NOT NULL DEFAULT 'platform'")
    if 'room_verified' not in columns:
        store.db.execute('ALTER TABLE reports ADD COLUMN room_verified INTEGER NOT NULL DEFAULT 0')
    store.db.executescript("""
        CREATE TABLE IF NOT EXISTS room_report_reviews(report_id INTEGER PRIMARY KEY,status TEXT NOT NULL DEFAULT 'open',
            note TEXT NOT NULL DEFAULT '',reviewer TEXT,revision INTEGER NOT NULL DEFAULT 0,updated REAL NOT NULL,
            FOREIGN KEY(report_id) REFERENCES reports(id));
        CREATE INDEX IF NOT EXISTS room_report_scope ON reports(room_id,audience,room_verified,id);
        CREATE INDEX IF NOT EXISTS room_report_status ON room_report_reviews(status,report_id);
    """)


def integer(value, description, minimum=1):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{1,19}', value):
        raise APIError(400, description)
    result = int(value)
    if not minimum <= result < 2 ** 63: raise APIError(400, description)
    return result


async def verified_context(service, session, kind, room, event, target):
    """Called only for new, explicit sharing; never retroactively opts in rows."""
    authority = await room_authority(service, session, room_id(room))
    if not authority.policies:
        raise APIError(400, 'Room moderator sharing is available only in a managed server or its canonical channels. Choose instance administrators instead.')
    token = service.store.open(session['token'])
    if kind in ('message', 'file'):
        if not re.fullmatch(r'\$[^\s\x00-\x1f\x7f]{1,254}', event):
            raise APIError(400, 'Choose the message containing the reported content.')
        original = await service.matrix('GET', '/_matrix/client/v3/rooms/' + quote(room, safe='') + '/event/' + quote(event, safe=''), token=token)
        if original.get('room_id') != room or original.get('event_id') != event or original.get('type') not in ('m.room.encrypted', 'm.room.message'):
            raise APIError(400, 'The reported event could not be verified in this room.')
        sender = user_id(original.get('sender'))
        if target and target != sender: raise APIError(400, 'The reported member does not match the message sender.')
        target = sender
    elif kind == 'user':
        target = user_id(target)
        if content(authority.state, 'm.room.member', target).get('membership') not in ('join', 'invite'):
            raise APIError(400, 'Choose a current or invited member of this room. To report a former member, report their message or contact instance administrators.')
        event = ''
    elif kind == 'server':
        if content(authority.state, 'm.room.create').get('type') != 'm.space':
            raise APIError(400, 'Choose the managed server itself when reporting a server.')
        target, event = room, ''
    else:
        raise APIError(400, 'Choose a valid report type.')
    return room, event, target


async def authority_for(request, identity):
    service = request.app['service']; session = service.require_session(request)
    authority = await room_authority(service, session, identity)
    if not authority.policies:
        raise APIError(403, 'Delegated report review requires a managed server or canonical channel.')
    authority.require('manage_reports', native='redact')
    if request.method == 'PUT':
        now = int(time.time() * 1000)
        if authority.model.temporary_ban_active(authority.state, session['user_id'], now) or any(authority.model.temporary_ban_active(parent, session['user_id'], now) for _, _, parent in authority.policies):
            raise APIError(403, 'A temporary ban prevents you from reviewing reports in this room.')
    service.require_session(request)
    return service, session, authority


def view(service, row):
    # Deliberately enumerate fields. Never serialize reports.note or its private
    # platform reviewer/status into a room moderator response.
    return {'id': row['id'], 'kind': row['kind'], 'roomId': row['room_id'], 'eventId': row['event_id'], 'targetId': row['target_id'],
        'reason': row['reason'], 'evidence': row['evidence'], 'reporter': row['reporter'], 'audience': 'room',
        'createdAt': int(row['created'] * 1000), 'updatedAt': int(row['room_updated'] * 1000),
        'status': row['room_status'], 'note': service.store.open(row['room_note']) if row['room_note'] else '',
        'reviewer': row['room_reviewer'], 'revision': row['room_revision']}


SELECT = """SELECT r.id,r.kind,r.room_id,r.event_id,r.target_id,r.reason,r.evidence,r.reporter,r.created,
    q.status AS room_status,q.note AS room_note,q.reviewer AS room_reviewer,q.revision AS room_revision,q.updated AS room_updated
    FROM reports r JOIN room_report_reviews q ON q.report_id=r.id
    WHERE r.audience='room' AND r.room_verified=1 AND r.room_id=?"""


async def queue(request):
    status = request.query.get('status', 'open')
    if status not in STATUSES | {'all'}: raise APIError(400, 'Choose a valid room report status.')
    before = integer(request.query.get('before', str(2 ** 63 - 1)), 'Choose a valid report page cursor.')
    service, session, authority = await authority_for(request, request.query.get('roomId'))
    service.store.rate('room-reports-read:' + session['user_id'], 120, 60)
    rows = service.store.db.execute(SELECT + " AND r.id<? AND (?='all' OR q.status=?) ORDER BY r.id DESC LIMIT 51", (authority.room_id, before, status, status)).fetchall()
    page = rows[:50]
    return web.json_response({'reports': [view(service, row) for row in page], 'next': page[-1]['id'] if len(rows) > 50 else None,
        'roomId': authority.room_id, 'audience': 'room'})


async def review(request):
    identity = integer(request.match_info['identity'], 'Choose a valid report ID.')
    if request.method == 'GET':
        service, _, authority = await authority_for(request, request.query.get('roomId'))
        row = service.store.db.execute(SELECT + ' AND r.id=?', (authority.room_id, identity)).fetchone()
        if not row: raise APIError(404, 'This shared room report is unavailable.')
        return web.json_response(view(service, row))
    data = await body_json(request)
    revision = data.get('revision')
    if type(revision) is not int or not 0 <= revision < 2 ** 63 - 1:
        raise APIError(400, 'Review the current report before updating it.')
    if not isinstance(data.get('status'), str) or data['status'] not in STATUSES: raise APIError(400, 'Choose a valid room report status.')
    note = text_value(data.get('note', ''), 2000).strip()
    service, session, authority = await authority_for(request, data.get('roomId'))
    service.store.rate('room-reports-review:' + session['user_id'], 120, 3600)
    row = service.store.db.execute(SELECT + ' AND r.id=?', (authority.room_id, identity)).fetchone()
    if not row: raise APIError(404, 'This shared room report is unavailable.')
    result = service.store.db.execute('UPDATE room_report_reviews SET status=?,note=?,reviewer=?,revision=revision+1,updated=? WHERE report_id=? AND revision=?',
        (data['status'], service.store.seal(note) if note else '', session['user_id'], time.time(), identity, revision))
    if not result.rowcount: raise APIError(409, 'Another moderator changed this review. Refresh the report before saving again.')
    service.audit(session['user_id'], 'room_report_reviewed', str(identity), authority.room_id + ' status:' + data['status'])
    updated = service.store.db.execute(SELECT + ' AND r.id=?', (authority.room_id, identity)).fetchone()
    return web.json_response(view(service, updated))


def register_routes(app):
    schema(app['service'].store)
    app.add_routes([web.get('/api/moderation/reports', queue), web.get('/api/moderation/reports/{identity}', review), web.put('/api/moderation/reports/{identity}', review)])
