"""Authenticated contact requests, explicit relationships, and account privacy."""
import asyncio
import re
import secrets
import time
from urllib.parse import quote

from aiohttp import web


def helpers():
    try:
        from .server import APIError, body_json
    except ImportError:
        from server import APIError, body_json
    return APIError, body_json


def ensure_schema(db):
    db.executescript('''
      CREATE TABLE IF NOT EXISTS social_requests(id TEXT PRIMARY KEY,sender TEXT NOT NULL,target TEXT NOT NULL,status TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS social_sender_status ON social_requests(sender,status,updated DESC);
      CREATE INDEX IF NOT EXISTS social_target_status ON social_requests(target,status,updated DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS social_active_pair ON social_requests(min(sender,target),max(sender,target)) WHERE status IN ('pending','accepted');
      CREATE TABLE IF NOT EXISTS social_preferences(user_id TEXT PRIMARY KEY,requests TEXT NOT NULL DEFAULT 'everyone');
      CREATE TABLE IF NOT EXISTS social_blocks(blocker TEXT NOT NULL,blocked TEXT NOT NULL,created REAL NOT NULL,PRIMARY KEY(blocker,blocked));
      CREATE INDEX IF NOT EXISTS social_blocked ON social_blocks(blocked,blocker);
    ''')


def authorized_transition(row, actor, operation):
    if row['status'] != 'pending':
        return False
    return (operation in ('accept', 'reject') and row['target'] == actor) or (operation == 'cancel' and row['sender'] == actor)


def session_context(request):
    service = request.app['service']
    session = service.require_session(request)
    return service, session, session['user_id']


def announce(request, *users):
    for user in users:
        for queue in request.app['social_watchers'].get(user, set()):
            if not queue.full():
                queue.put_nowait(True)


async def events(request):
    service, session, user = session_context(request)
    watchers = request.app['social_watchers'].setdefault(user, set())
    if len(watchers) >= 5:
        APIError, _ = helpers()
        raise APIError(429, 'Too many contact update streams are open.')
    queue = asyncio.Queue(maxsize=1)
    watchers.add(queue)
    response = web.StreamResponse(headers={'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})
    try:
        await response.prepare(request)
        await response.write(b'data: changed\n\n')
        while True:
            try:
                await asyncio.wait_for(queue.get(), 20)
                await response.write(b'data: changed\n\n')
            except asyncio.TimeoutError:
                if not service.store.db.execute('SELECT 1 FROM sessions WHERE id=? AND expires>?', (session['id'], time.time())).fetchone():
                    break
                await response.write(b': heartbeat\n\n')
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        watchers.discard(queue)
        if not watchers:
            request.app['social_watchers'].pop(user, None)
    return response


def snapshot(db, user):
    rows = db.execute("SELECT id,sender,target,status,created,updated FROM social_requests WHERE (sender=? OR target=?) AND status IN ('pending','accepted') ORDER BY updated DESC LIMIT 501", (user, user)).fetchall()
    blocked = [row[0] for row in db.execute('SELECT blocked FROM social_blocks WHERE blocker=? ORDER BY created DESC LIMIT 1000', (user,))]
    preference = db.execute('SELECT requests FROM social_preferences WHERE user_id=?', (user,)).fetchone()
    return {'requests': [dict(row) for row in rows[:500]], 'hasMore': len(rows) > 500, 'blocked': blocked, 'privacy': preference[0] if preference else 'everyone'}


async def state(request):
    service, session, user = session_context(request)
    return web.json_response(snapshot(service.store.db, user))


async def same_server(service, session, target):
    token = service.store.open(session['token'])
    joined = await service.matrix('GET', '/_matrix/client/v3/joined_rooms', token=token)
    # Only inspect the caller's own joined rooms, in small batches; never query an
    # administrator's global room/member list or trust a client-provided server ID.
    async def check(room):
        base = '/_matrix/client/v3/rooms/' + quote(room, safe='') + '/state/'
        code, creation = await service.matrix('GET', base + 'm.room.create', token=token, expected=False)
        if code != 200 or creation.get('type') != 'm.space':
            return False
        code, member = await service.matrix('GET', base + 'm.room.member/' + quote(target, safe=''), token=token, expected=False)
        return code == 200 and member.get('membership') == 'join'
    room_ids = joined.get('joined_rooms', [])[:200]
    for index in range(0, len(room_ids), 4):
        if any(await asyncio.gather(*(check(room) for room in room_ids[index:index + 4]))):
            return True
    return False


async def send_request(request):
    APIError, body_json = helpers()
    service, session, user = session_context(request)
    service.store.rate('friend-request:' + user, 10, 300)
    value = await body_json(request)
    target = value.get('target')
    if not isinstance(target, str) or not re.fullmatch(r'@[^\s:]{1,128}:[^\s]{1,255}', target) or target == user:
        raise APIError(400, 'Enter another member’s full Matrix ID.')
    # Accounts on this self-hosted instance have durable privacy settings here.
    if target.split(':', 1)[1] != user.split(':', 1)[1]:
        raise APIError(400, 'Contact requests are available to accounts on this Tavern instance.')
    db = service.store.db
    if db.execute('SELECT 1 FROM social_blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)', (user, target, target, user)).fetchone():
        raise APIError(403, 'This contact request cannot be sent.')
    preference = db.execute('SELECT requests FROM social_preferences WHERE user_id=?', (target,)).fetchone()
    if preference and (preference[0] == 'nobody' or (preference[0] == 'shared_server' and not await same_server(service, session, target))):
        raise APIError(403, 'This member’s privacy settings do not allow this contact request.')
    token = service.store.open(session['token'])
    status, profile = await service.matrix('GET', '/_matrix/client/v3/profile/' + quote(target, safe=''), token=token, expected=False)
    if status != 200:
        raise APIError(400, 'That account could not be found.')
    # An awaited homeserver request must not let a concurrent privacy/block update
    # become a stale authorization decision.
    current_preference = db.execute('SELECT requests FROM social_preferences WHERE user_id=?', (target,)).fetchone()
    if (current_preference[0] if current_preference else 'everyone') != (preference[0] if preference else 'everyone'):
        raise APIError(409, 'Privacy settings changed. Retry the request.')
    if db.execute('SELECT 1 FROM social_blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)', (user, target, target, user)).fetchone():
        raise APIError(403, 'This contact request cannot be sent.')
    now = time.time()
    active = db.execute("SELECT id FROM social_requests WHERE ((sender=? AND target=?) OR (sender=? AND target=?)) AND status IN ('pending','accepted')", (user, target, target, user)).fetchone()
    if active:
        raise APIError(409, 'A contact request or relationship already exists. Check Pending and Contacts.')
    if db.execute("SELECT count(*) FROM social_requests WHERE (sender=? OR target=?) AND status IN ('pending','accepted')", (user, user)).fetchone()[0] >= 500:
        raise APIError(409, 'Your contact list is full. Remove a contact or cancel a request first.')
    if db.execute("SELECT count(*) FROM social_requests WHERE (sender=? OR target=?) AND status IN ('pending','accepted')", (target, target)).fetchone()[0] >= 500:
        raise APIError(409, 'This member cannot receive more contact requests right now.')
    if db.execute('SELECT 1 FROM social_requests WHERE sender=? AND target=? AND updated>?', (user, target, now - 86400)).fetchone():
        raise APIError(429, 'Wait one day before sending another request to this member.')
    db.execute('INSERT INTO social_requests VALUES(?,?,?,?,?,?)', (secrets.token_urlsafe(18), user, target, 'pending', now, now))
    service.audit(user, 'contacts.requested', target)
    announce(request, user, target)
    return web.json_response(snapshot(db, user), status=201)


async def respond(request):
    APIError, body_json = helpers()
    service, session, user = session_context(request)
    service.store.rate('contacts:' + user, 60, 60)
    value = await body_json(request)
    operation = value.get('operation')
    row = service.store.db.execute('SELECT * FROM social_requests WHERE id=?', (request.match_info['identity'],)).fetchone()
    if not row or user not in (row['sender'], row['target']):
        raise APIError(404, 'Contact request not found.')
    if not authorized_transition(row, user, operation):
        raise APIError(403, 'You cannot make that change to this request.')
    statuses = {'accept': 'accepted', 'reject': 'rejected', 'cancel': 'cancelled'}
    service.store.db.execute('UPDATE social_requests SET status=?,updated=? WHERE id=? AND status=?', (statuses[operation], time.time(), row['id'], 'pending'))
    service.audit(user, 'contacts.' + operation, row['id'])
    announce(request, row['sender'], row['target'])
    return web.json_response(snapshot(service.store.db, user))


async def remove_contact(request):
    service, session, user = session_context(request)
    peer = request.match_info['peer']
    service.store.db.execute("UPDATE social_requests SET status='removed',updated=? WHERE ((sender=? AND target=?) OR (sender=? AND target=?)) AND status='accepted'", (time.time(), user, peer, peer, user))
    service.audit(user, 'contacts.removed', peer)
    announce(request, user, peer)
    return web.json_response(snapshot(service.store.db, user))


async def privacy(request):
    APIError, body_json = helpers()
    service, session, user = session_context(request)
    value = await body_json(request)
    preference = value.get('requests')
    if preference not in ('everyone', 'shared_server', 'nobody'):
        raise APIError(400, 'Choose who can send you contact requests.')
    service.store.db.execute('INSERT INTO social_preferences VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET requests=excluded.requests', (user, preference))
    announce(request, user)
    return web.json_response(snapshot(service.store.db, user))


async def block(request):
    service, session, user = session_context(request)
    lock = request.app['social_locks'].setdefault(user, asyncio.Lock())
    async with lock:
        return await update_block(request)


async def update_block(request):
    APIError, body_json = helpers()
    service, session, user = session_context(request)
    service.store.rate('blocks:' + user, 30, 60)
    peer = request.match_info['peer']
    if not re.fullmatch(r'@[^\s:]{1,128}:[^\s]{1,255}', peer) or peer == user:
        raise APIError(400, 'Choose another valid Matrix account.')
    blocked = request.method == 'PUT'
    path = '/_matrix/client/v3/user/' + quote(user, safe='') + '/account_data/m.ignored_user_list'
    token = service.store.open(session['token'])
    code, data = await service.matrix('GET', path, token=token, expected=False)
    if code not in (200, 404):
        raise APIError(502, 'Could not read the homeserver’s blocked users. Retry shortly.')
    ignored = dict(data.get('ignored_users', {}))
    if blocked:
        ignored[peer] = {}
    else:
        ignored.pop(peer, None)
    await service.matrix('PUT', path, {'ignored_users': ignored}, token=token)
    db = service.store.db
    if blocked:
        db.execute('INSERT OR IGNORE INTO social_blocks VALUES(?,?,?)', (user, peer, time.time()))
        db.execute("UPDATE social_requests SET status='removed',updated=? WHERE ((sender=? AND target=?) OR (sender=? AND target=?)) AND status IN ('pending','accepted')", (time.time(), user, peer, peer, user))
    else:
        db.execute('DELETE FROM social_blocks WHERE blocker=? AND blocked=?', (user, peer))
    service.audit(user, 'contacts.blocked' if blocked else 'contacts.unblocked', peer)
    announce(request, user, peer)
    return web.json_response(snapshot(db, user))


def register_routes(app):
    ensure_schema(app['service'].store.db)
    app['social_watchers'] = {}
    app['social_locks'] = {}
    app.add_routes([web.get('/api/social', state), web.get('/api/social/events', events), web.post('/api/social/requests', send_request), web.patch('/api/social/requests/{identity}', respond),
                    web.delete('/api/social/contacts/{peer}', remove_contact), web.put('/api/social/privacy', privacy), web.put('/api/social/blocks/{peer}', block), web.delete('/api/social/blocks/{peer}', block)])
