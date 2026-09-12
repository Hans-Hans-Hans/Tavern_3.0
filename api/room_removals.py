"""Reviewed, resumable native channel/server deletion.

The journal stores the exact approved room set. Each destructive step requires
the owning session and fresh native ownership; polling a result never starts a
new deletion. Synapse owns its durable purge tasks and is never force-purged.
"""
import asyncio
import json
import re
import secrets
import sqlite3
import time
from weakref import WeakValueDictionary
from urllib.parse import quote

from aiohttp import ClientError, web

try:
    from .server import APIError, body_json
    from .room_authority import content, room_authority, state
    from .room_removal_scope import removal_scope, space_owner
except ImportError:
    from server import APIError, body_json
    from room_authority import content, room_authority, state
    from room_removal_scope import removal_scope, space_owner


class RoomRemovals:
    def __init__(self, service):
        self.service, self.locks = service, WeakValueDictionary()
        service.store.db.executescript('''
            CREATE TABLE IF NOT EXISTS room_removals(id TEXT PRIMARY KEY,actor TEXT NOT NULL,
                room_id TEXT NOT NULL,phase TEXT NOT NULL,document TEXT NOT NULL,
                created REAL NOT NULL,updated REAL NOT NULL,issue TEXT NOT NULL DEFAULT '');
            CREATE INDEX IF NOT EXISTS room_removal_owner ON room_removals(actor,room_id,created);
            CREATE TABLE IF NOT EXISTS room_removal_claims(room_id TEXT PRIMARY KEY,operation TEXT NOT NULL);
        ''')

    def load(self, identity, actor):
        if not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}', identity):
            raise APIError(404, 'Deletion request not found.')
        row = self.service.store.db.execute('SELECT * FROM room_removals WHERE id=? AND actor=?', (identity, actor)).fetchone()
        if not row:
            raise APIError(404, 'Deletion request not found.')
        result = dict(row)
        result['document'] = json.loads(self.service.store.open(result['document']))
        return result

    def save(self, job, phase=None, issue=''):
        job['phase'], job['issue'], job['updated'] = phase or job['phase'], issue, time.time()
        self.service.store.db.execute('UPDATE room_removals SET phase=?,document=?,updated=?,issue=? WHERE id=?',
            (job['phase'], self.service.store.seal(json.dumps(job['document'])), job['updated'], issue, job['id']))

    def view(self, job):
        plan, progress = job['document']['plan'], job['document']['progress']
        return {'id': job['id'], 'roomId': job['room_id'], 'kind': plan['kind'], 'name': plan['name'],
                'phase': job['phase'], 'issue': job['issue'], 'createdAt': int(job['created'] * 1000),
                'targets': [{**target, 'state': progress[target['id']]['state']} for target in plan['targets']],
                'completed': sum(value['state'] == 'complete' for value in progress.values())}

    def deny_calls(self, identity):
        if not isinstance(identity, str):
            return
        if self.service.store.db.execute('SELECT 1 FROM room_removal_claims WHERE room_id=?', (identity,)).fetchone():
            raise APIError(403, 'This room is not available for a Tavern conference.', 'CALL_ACCESS_DENIED')

    async def review(self, session, identity):
        now = time.time()
        self.service.store.db.execute("DELETE FROM room_removals WHERE actor=? AND phase='review' AND created<?", (session['user_id'], now - 600))
        if self.service.store.db.execute("SELECT count(*) FROM room_removals WHERE actor=? AND phase='review'", (session['user_id'],)).fetchone()[0] >= 20:
            raise APIError(429, 'Too many deletion reviews. Wait ten minutes before opening another.')
        plan = await removal_scope(self.service, session, identity)
        now, operation = time.time(), secrets.token_urlsafe(18)
        document = {'plan': plan, 'progress': {target['id']: {'state': 'ready', 'nativeId': None} for target in plan['targets']}}
        self.service.store.db.execute("DELETE FROM room_removals WHERE actor=? AND phase='review' AND created<?", (session['user_id'], now - 600))
        self.service.store.db.execute('INSERT INTO room_removals(id,actor,room_id,phase,document,created,updated) VALUES(?,?,?,?,?,?,?)',
            (operation, session['user_id'], identity, 'review', self.service.store.seal(json.dumps(document)), now, now))
        return self.load(operation, session['user_id'])

    def confirm(self, job):
        db = self.service.store.db
        db.execute('BEGIN IMMEDIATE')
        try:
            for target in job['document']['plan']['targets']:
                db.execute('INSERT INTO room_removal_claims(room_id,operation) VALUES(?,?)', (target['id'], job['id']))
            self.save(job, 'ready')
            self.service.audit(job['actor'], 'room_deletion_requested', job['room_id'], job['id'])
            db.execute('COMMIT')
        except sqlite3.IntegrityError:
            db.execute('ROLLBACK')
            raise APIError(409, 'One of these rooms already has an unfinished deletion. Resume its existing request.') from None
        except BaseException:
            db.execute('ROLLBACK')
            raise

    async def parent(self, session, identity):
        authority = await room_authority(self.service, session, identity)
        if not space_owner(authority.state, session['user_id'], authority.model):
            raise APIError(403, 'Native server ownership changed. Ask the current owner to review the remaining deletion.')
        return authority

    async def authorize_target(self, session, plan, target):
        parents = target['parents']
        if target['kind'] == 'server':
            authority = await self.parent(session, target['id'])
            if any(kind == 'm.space.child' and event.content.get('via') for (kind, _), event in authority.state.items()):
                raise APIError(409, 'The server contains additional channels. Review its remaining deletion again.')
            return
        authorities = {identity: await self.parent(session, identity) for identity in parents}
        current = await state(self.service, target['id'])
        creation = content(current, 'm.room.create')
        canonical = {key for (kind, key), event in current.items() if kind == 'm.space.parent' and event.content.get('canonical') is True and event.content.get('via')}
        if (canonical != set(parents) or creation.get('type') or creation.get('m.federate') is not False
                or content(current, 'm.room.encryption').get('algorithm') != 'm.megolm.v1.aes-sha2'
                or any(not content(authority.state, 'm.space.child', target['id']).get('via') for authority in authorities.values())):
            raise APIError(409, 'This channel or its parent links changed. Review deletion again.')

    async def native(self, method, path, body=None, current=None):
        token = await self.service.service_token()
        if method != 'GET':
            if current is None:
                raise APIError(401, 'Confirm this deletion from its owning session.')
            current()
        return await self.service.matrix(method, '/_synapse/admin/' + path, body, token=token)

    async def purged(self, identity):
        try:
            await self.native('GET', 'v1/rooms/' + quote(identity, safe=''))
            return False
        except APIError as error:
            if error.status != 404:
                raise
        blocked = await self.native('GET', 'v1/rooms/' + quote(identity, safe='') + '/block')
        return blocked.get('block') is True

    async def native_status(self, item, identity):
        path = 'v2/rooms/' + quote(identity, safe='') + '/delete_status'
        if item['nativeId']:
            path = 'v2/rooms/delete_status/' + quote(item['nativeId'], safe='')
        try:
            response = await self.native('GET', path)
        except APIError as error:
            if error.status == 404:
                return None
            raise
        values = [response] if item['nativeId'] else response.get('results')
        if not isinstance(values, list) or len(values) > 100:
            raise APIError(503, 'The native deletion result could not be checked.')
        values = [value for value in values if isinstance(value, dict) and value.get('room_id') == identity]
        active = [value for value in values if value.get('status') == 'active']
        if len(active) > 1:
            raise APIError(503, 'More than one native deletion is active. Ask an administrator to check the room.')
        selected = active[0] if active else values[0] if len(values) == 1 else None
        if selected:
            native_id = selected.get('delete_id')
            if not isinstance(native_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', native_id):
                raise APIError(503, 'The native deletion reference is invalid.')
            item['nativeId'] = native_id
        return selected

    async def clean_parent(self, session, parent_id, removed, current_session):
        authority = await self.parent(session, parent_id)
        current, model = authority.state, authority.model
        token = self.service.store.open(session['token'])
        path = '/_matrix/client/v3/rooms/' + quote(parent_id, safe='') + '/state/'
        policy = content(current, model.POLICY)
        if removed in policy.get('channelAdmissions', {}) or removed in policy.get('overrides', {}):
            next_policy = {**policy, 'overrides': {key: value for key, value in policy.get('overrides', {}).items() if key != removed},
                           'io.tavern.previous_event': current[model.POLICY, ''].event_id}
            if 'channelAdmissions' in policy:
                next_policy['channelAdmissions'] = {key: value for key, value in policy['channelAdmissions'].items() if key != removed}
            current_session()
            await self.service.matrix('PUT', path + quote(model.POLICY, safe='') + '/', next_policy, token)
        authority = await self.parent(session, parent_id)
        layout = content(authority.state, model.LAYOUT)
        if layout:
            if not model.valid_layout(layout):
                raise APIError(409, 'The channel was removed, but its server layout needs repair.')
            if any(row['id'] == removed for row in layout['channels']):
                current_session()
                await self.service.matrix('PUT', path + quote(model.LAYOUT, safe='') + '/',
                    {**layout, 'channels': [row for row in layout['channels'] if row['id'] != removed],
                     'io.tavern.previous_event': authority.state[model.LAYOUT, ''].event_id}, token)
        authority = await self.parent(session, parent_id)
        if content(authority.state, 'm.space.child', removed).get('via'):
            current_session()
            await self.service.matrix('PUT', path + 'm.space.child/' + quote(removed, safe=''), {}, token)
        final = await self.parent(session, parent_id)
        if (removed in content(final.state, model.POLICY).get('channelAdmissions', {})
                or any(row.get('id') == removed for row in content(final.state, model.LAYOUT).get('channels', []))
                or content(final.state, 'm.space.child', removed).get('via')):
            raise APIError(409, 'Native deletion completed, but channel-list cleanup is not yet confirmed.')

    async def advance(self, job, session, current_session, retry=False):
        current_session()
        if job['phase'] in {'review', 'complete'} or job['phase'] == 'attention' and not retry:
            return
        plan, progress = job['document']['plan'], job['document']['progress']
        target = next((target for target in plan['targets'] if progress[target['id']]['state'] != 'complete'), None)
        if not target:
            self.save(job, 'complete')
            return
        identity, item = target['id'], progress[target['id']]
        try:
            if item['state'] == 'submitted':
                status = await self.native_status(item, identity)
                if await self.purged(identity):
                    item['state'] = 'purged'
                    self.save(job, 'metadata')
                elif status and status.get('status') == 'active':
                    self.save(job, 'native_pending')
                    return
                elif status and status.get('status') == 'failed':
                    if retry:
                        item['state'], item['nativeId'] = 'ready', None
                    else:
                        self.save(job, 'attention', 'Synapse could not finish removing this room. Review and retry, or ask an administrator to inspect it.')
                        return
                elif status is None and retry:
                    # Explicit retry after the native task lookup and absence
                    # check. Synapse rejects a second active purge of this room.
                    item['state'], item['nativeId'] = 'ready', None
                else:
                    self.save(job, 'attention', 'The native removal could not be confirmed. Check its status before retrying.')
                    return
            if item['state'] == 'ready':
                await self.authorize_target(session, plan, target)
                current_session()
                # Record intent before the network request; a lost response is
                # reconciled by exact native room ID, never by blindly replaying.
                item['state'] = 'submitted'
                self.save(job, 'native_pending')
                result = await self.native('DELETE', 'v2/rooms/' + quote(identity, safe=''), {'block': True, 'purge': True, 'force_purge': False}, current_session)
                native_id = result.get('delete_id')
                if not isinstance(native_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', native_id):
                    raise APIError(503, 'The native deletion acknowledgement needs another check.')
                item['nativeId'] = native_id
                self.save(job, 'native_pending')
                return
            if item['state'] == 'purged':
                for parent in target['parents']:
                    await self.clean_parent(session, parent, identity, current_session)
                item['state'] = 'complete'
                db = self.service.store.db
                db.execute('BEGIN IMMEDIATE')
                try:
                    self.service.audit(session['user_id'], 'room_deleted', identity, job['id'])
                    self.save(job, 'complete' if all(item['state'] == 'complete' for item in progress.values()) else 'ready')
                    db.execute('DELETE FROM room_removal_claims WHERE room_id=? AND operation=?', (identity, job['id']))
                    db.execute('COMMIT')
                except BaseException:
                    db.execute('ROLLBACK')
                    raise
        except APIError:
            # Status/body may contain upstream details. Only product-owned
            # categories survive the journal; a separate read can reconcile.
            self.save(job, 'attention', 'Deletion paused. Refresh its status and retry after checking current ownership and server availability.')
        except (ClientError, OSError, asyncio.TimeoutError):
            self.save(job, 'attention', 'Deletion paused while waiting for Synapse. Refresh its status before retrying.')


def register_routes(app):
    service = app['service']
    removals = service.room_removals = RoomRemovals(service)

    async def review(request):
        session = service.require_session(request)
        job = await removals.review(session, request.match_info['room_id'])
        service.require_session(request)
        return web.json_response(removals.view(job), headers={'Cache-Control': 'no-store'})

    async def latest(request):
        session = service.require_session(request)
        row = service.store.db.execute("SELECT id FROM room_removals WHERE actor=? AND room_id=? ORDER BY CASE WHEN phase NOT IN ('review','complete') THEN 0 ELSE 1 END,created DESC LIMIT 1",
            (session['user_id'], request.match_info['room_id'])).fetchone()
        return web.json_response({'operation': removals.view(removals.load(row['id'], session['user_id'])) if row else None}, headers={'Cache-Control': 'no-store'})

    async def listing(request):
        session = service.require_session(request)
        rows = service.store.db.execute("SELECT id FROM room_removals WHERE actor=? AND phase!='review' ORDER BY CASE WHEN phase!='complete' THEN 0 ELSE 1 END,updated DESC LIMIT 100", (session['user_id'],)).fetchall()
        return web.json_response({'operations': [removals.view(removals.load(row['id'], session['user_id'])) for row in rows]}, headers={'Cache-Control': 'no-store'})

    async def operate(request):
        session = service.require_session(request)
        identity = request.match_info['operation']
        removals.load(identity, session['user_id'])
        lock = removals.locks.setdefault(identity, asyncio.Lock())
        async with lock:
            job = removals.load(identity, session['user_id'])
            action = request.match_info.get('action')
            data = await body_json(request) if action else {}
            def current():
                if service.require_session(request)['id'] != session['id']:
                    raise APIError(401, 'Your session changed. Reopen deletion status.')
            if action == 'confirm':
                if set(data) != {'confirmation'}:
                    raise APIError(400, 'Confirm only the reviewed deletion.')
                if data.get('confirmation') != job['document']['plan']['name']:
                    raise APIError(400, 'Type the channel or server name exactly to confirm deletion.')
                if job['phase'] == 'review':
                    if time.time() - job['created'] > 600:
                        raise APIError(409, 'This deletion review expired. Review it again.')
                    reviewed = await removal_scope(service, session, job['room_id'])
                    current()
                    if reviewed != job['document']['plan']:
                        raise APIError(409, 'The deletion scope changed. Review it again.')
                    removals.confirm(job)
            elif action == 'continue':
                if set(data) - {'retry'} or 'retry' in data and type(data['retry']) is not bool:
                    raise APIError(400, 'Choose a valid continuation.')
                await removals.advance(job, session, current, data.get('retry', False))
            service.require_session(request)
            return web.json_response(removals.view(job), headers={'Cache-Control': 'no-store'})

    app.add_routes([web.get('/api/room-removals', listing), web.post('/api/rooms/{room_id}/removal-review', review), web.get('/api/rooms/{room_id}/removal', latest),
                    web.get('/api/room-removals/{operation}', operate), web.post('/api/room-removals/{operation}/{action:confirm|continue}', operate)])
