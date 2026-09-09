"""Private, encrypted-at-rest warnings with actual room moderation authority."""
import time
from aiohttp import web

try:
    from .server import APIError, body_json, text_value
    from .room_authority import room_authority, user_id
except ImportError:
    from server import APIError, body_json, text_value
    from room_authority import room_authority, user_id


def view(service, row, own=False):
    value = {'id': row['id'], 'roomId': row['room_id'], 'targetId': row['target'], 'actor': row['actor'], 'reason': service.store.open(row['reason']),
             'createdAt': int(row['created'] * 1000), 'status': row['status'], 'withdrawnAt': int(row['withdrawn'] * 1000) if row['withdrawn'] else None, 'withdrawnBy': row['withdrawn_by']}
    if own: value['read'] = bool(row['read_at'])
    return value


def before(request):
    try:
        value = int(request.query.get('before', str(2 ** 63 - 1)))
        if not 0 < value < 2 ** 63: raise ValueError()
        return value
    except ValueError:
        raise APIError(400, 'Use a valid warning page cursor.') from None


async def warnings(request):
    service = request.app['service']; session = service.require_session(request)
    if request.method == 'GET':
        authority = await room_authority(service, session, request.query.get('roomId')); authority.require('manage_messages')
        service.require_session(request)
        target = request.query.get('targetId', '')
        if target: user_id(target)
        rows = service.store.db.execute('SELECT * FROM moderation_warnings WHERE room_id=? AND id<? AND (?=\'\' OR target=?) ORDER BY id DESC LIMIT 50', (authority.room_id, before(request), target, target)).fetchall()
        return web.json_response({'warnings': [view(service, row) for row in rows], 'next': rows[-1]['id'] if len(rows) == 50 else None})
    data = await body_json(request); target = user_id(data.get('targetId'))
    if data.get('confirmation') != target: raise APIError(400, 'Confirm the account receiving this warning.')
    reason = text_value(data.get('reason'), 1000).strip()
    if not reason: raise APIError(400, 'Explain the behavior that needs to change.')
    service.store.rate('moderation-warning:' + session['user_id'], 20, 3600)
    authority = await room_authority(service, session, data.get('roomId')); authority.require('manage_messages', target=target, target_joined=True)
    service.require_session(request)  # A long state lookup must not retain a revoked session.
    identity = service.store.db.execute('INSERT INTO moderation_warnings(room_id,target,actor,reason,created) VALUES(?,?,?,?,?)',
        (authority.room_id, target, session['user_id'], service.store.seal(reason), time.time())).lastrowid
    service.audit(session['user_id'], 'member_warned', target, authority.room_id + ' warning:' + str(identity))
    service.background(service.security_notice(target, 'A moderator sent you a warning', 'A room moderator sent you a private warning. Open Tavern and review your moderation inbox. Warning reasons are not included in email.'))
    row = service.store.db.execute('SELECT * FROM moderation_warnings WHERE id=?', (identity,)).fetchone()
    return web.json_response(view(service, row), status=201)


async def withdraw(request):
    service = request.app['service']; session = service.require_session(request); data = await body_json(request)
    try: identity = int(request.match_info['identity'])
    except ValueError: raise APIError(404, 'This warning is unavailable.') from None
    row = service.store.db.execute('SELECT * FROM moderation_warnings WHERE id=?', (identity,)).fetchone()
    if not row: raise APIError(404, 'This warning is unavailable.')
    authority = await room_authority(service, session, row['room_id']); authority.require('manage_messages', target=row['target'])
    if data.get('confirmation') != row['target']: raise APIError(400, 'Confirm the account whose warning is being withdrawn.')
    service.require_session(request)
    if row['status'] != 'withdrawn':
        service.store.db.execute("UPDATE moderation_warnings SET status='withdrawn',withdrawn=?,withdrawn_by=? WHERE id=?", (time.time(), session['user_id'], identity))
        service.audit(session['user_id'], 'member_warning_withdrawn', row['target'], row['room_id'] + ' warning:' + str(identity))
    row = service.store.db.execute('SELECT * FROM moderation_warnings WHERE id=?', (identity,)).fetchone()
    return web.json_response(view(service, row))


async def mine(request):
    service = request.app['service']; session = service.require_session(request)
    rows = service.store.db.execute('SELECT * FROM moderation_warnings WHERE target=? AND id<? ORDER BY id DESC LIMIT 50', (session['user_id'], before(request))).fetchall()
    unread = service.store.db.execute("SELECT count(*) FROM moderation_warnings WHERE target=? AND read_at IS NULL AND status='active'", (session['user_id'],)).fetchone()[0]
    return web.json_response({'warnings': [view(service, row, True) for row in rows], 'next': rows[-1]['id'] if len(rows) == 50 else None, 'unread': unread})


async def mark_read(request):
    service = request.app['service']; session = service.require_session(request); data = await body_json(request)
    identity = data.get('throughId')
    if type(identity) is not int or not 0 < identity < 2 ** 63: raise APIError(400, 'Choose a warning you have opened.')
    if not service.store.db.execute('SELECT 1 FROM moderation_warnings WHERE id=? AND target=?', (identity, session['user_id'])).fetchone():
        raise APIError(404, 'This warning is unavailable.')
    service.store.db.execute('UPDATE moderation_warnings SET read_at=? WHERE target=? AND id<=? AND read_at IS NULL', (time.time(), session['user_id'], identity))
    return web.json_response({'ok': True})


def register_routes(app):
    app['service'].store.db.executescript("""
        CREATE TABLE IF NOT EXISTS moderation_warnings(id INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT NOT NULL,target TEXT NOT NULL,
            actor TEXT NOT NULL,reason TEXT NOT NULL,created REAL NOT NULL,status TEXT NOT NULL DEFAULT 'active',withdrawn REAL,withdrawn_by TEXT,read_at REAL);
        CREATE INDEX IF NOT EXISTS moderation_warning_room ON moderation_warnings(room_id,id);
        CREATE INDEX IF NOT EXISTS moderation_warning_target ON moderation_warnings(target,id);
        CREATE INDEX IF NOT EXISTS moderation_warning_unread ON moderation_warnings(target,status,read_at);
    """)
    app.add_routes([web.get('/api/moderation/warnings', warnings), web.post('/api/moderation/warnings', warnings),
        web.post('/api/moderation/warnings/{identity}/withdraw', withdraw), web.get('/api/moderation/warnings/mine', mine), web.post('/api/moderation/warnings/read', mark_read)])
