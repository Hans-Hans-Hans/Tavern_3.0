"""Bounded, read-only native Space relationship pages for instance administrators."""
import asyncio
import hashlib
import json
import re
import time
from urllib.parse import quote

from aiohttp import ClientError, web

try:
    from .server import APIError
    from .room_authority import room_id, user_id
except ImportError:
    from server import APIError
    from room_authority import room_id, user_id

PAGE_SIZE = 20
MAX_LINKS = 200
MAX_BYTES = 1024 * 1024
MAX_EVENTS = 10000
CONCURRENCY = 3
REQUEST_SECONDS = 3
PAGE_SECONDS = 12
KINDS = {'m.room.create', 'm.room.name', 'm.room.encryption', 'm.room.tombstone',
         'm.room.join_rules', 'io.tavern.channel', 'm.space.parent', 'm.space.child'}


def identity(value):
    try:
        valid = isinstance(value, str) and len(value.encode('utf-8')) <= 255
    except UnicodeError:
        valid = False
    if not valid:
        raise APIError(400, 'Choose a valid room ID.')
    return room_id(value)


def valid_id(value):
    try:
        return identity(value)
    except APIError:
        return None


def valid_user(value):
    try:
        return user_id(value) if len(value.encode('utf-8')) <= 255 else None
    except (APIError, AttributeError):
        return None


def label(value, maximum=200):
    return value[:maximum] if isinstance(value, str) and not re.search(r'[\x00-\x1f\x7f]', value) else None


def via(content):
    value = content.get('via')
    return (isinstance(value, list) and 0 < len(value) <= 10 and
            all(isinstance(server, str) and re.fullmatch(r'[A-Za-z0-9.\-:\[\]]{1,255}', server) for server in value))


def routing(content, parent=False):
    return via(content) and (not parent or 'canonical' not in content or type(content['canonical']) is bool)


def parse_state(value, target):
    events = value.get('state') if isinstance(value, dict) else None
    if not isinstance(events, list) or len(events) > MAX_EVENTS:
        raise ValueError('state')
    state, seen, joined = {}, set(), 0
    for event in events:
        if (not isinstance(event, dict) or not isinstance(event.get('type'), str) or
                not isinstance(event.get('state_key'), str) or not isinstance(event.get('content'), dict) or
                ('room_id' in event and event['room_id'] != target)):
            raise ValueError('state')
        key = (event['type'], event['state_key'])
        if key in seen:
            raise ValueError('duplicate state')
        seen.add(key)
        if key[0] == 'm.room.member':
            if event['content'].get('membership') not in ('join', 'invite', 'leave', 'ban', 'knock') or not valid_user(key[1]):
                raise ValueError('membership')
            joined += event['content']['membership'] == 'join'
        elif key[0] in KINDS:
            # Never return full state, profile fields, invite reasons or membership IDs.
            state[key] = event
    create = state.get(('m.room.create', ''))
    if not create or not valid_user(create.get('sender')):
        raise ValueError('create')
    content = create['content']
    if 'type' in content and not isinstance(content['type'], str):
        raise ValueError('room type')
    encryption = state.get(('m.room.encryption', ''))
    if encryption and not label(encryption['content'].get('algorithm'), 128):
        raise ValueError('encryption')
    version = content.get('room_version', '1')
    if not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,32}', version):
        raise ValueError('version')
    additional = content.get('additional_creators', []) if version == '12' else []
    if (not isinstance(additional, list) or len(additional) > 20 or
            not all(valid_user(user) for user in additional) or len(set(additional)) != len(additional)):
        raise ValueError('creators')
    return state, joined


def metadata(target, state, joined):
    def data(kind):
        return state.get((kind, ''), {}).get('content', {})
    event = state[('m.room.create', '')]
    creation = event['content']
    version = creation.get('room_version', '1')
    timestamp = event.get('origin_server_ts')
    creators = list(dict.fromkeys([event['sender']] + (creation.get('additional_creators', []) if version == '12' else [])))
    tombstone = data('m.room.tombstone')
    return {'roomId': target, 'status': 'available', 'name': label(data('m.room.name').get('name')),
            'kind': 'server' if creation.get('type') == 'm.space' else 'conversation',
            'roomVersion': version, 'creators': creators,
            'creatorAuthority': 'inherent' if version == '12' else 'power-level based',
            'createdAt': timestamp if type(timestamp) is int and 0 < timestamp <= 9007199254740991 else None,
            'joinedMembers': joined, 'encryption': label(data('m.room.encryption').get('algorithm'), 128),
            'joinRule': label(data('m.room.join_rules').get('join_rule'), 32),
            'archived': data('io.tavern.channel').get('archived') if type(data('io.tavern.channel').get('archived')) is bool else None,
            'replacementRoomId': valid_id(tombstone.get('replacement_room')), 'storageBytes': None, 'activityAt': None}


def candidates(state):
    result, omitted = [], 0
    for (kind, key), event in state.items():
        if kind not in ('m.space.parent', 'm.space.child'):
            continue
        content = event['content']
        # An empty state event is the native way to remove a link.
        if not content:
            continue
        target = valid_id(key)
        if not target:
            omitted += 1
            continue
        result.append({'direction': 'parent' if kind == 'm.space.parent' else 'child',
                       'roomId': target, 'valid': routing(content, kind == 'm.space.parent'), 'canonical': content.get('canonical') is True})
    return sorted(result, key=lambda row: (row['direction'], row['roomId'])), omitted


def revision(state, joined):
    # Include all relationship candidates, even those outside this bounded page.
    value = [[kind, key, event] for (kind, key), event in sorted(state.items())]
    return hashlib.sha256(json.dumps([value, joined], sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class Inspector:
    def __init__(self, request, session):
        self.request, self.service, self.session = request, request.app['service'], session
        self.token = self.service.store.open(session['token'])
        self.slots = asyncio.Semaphore(CONCURRENCY)

    def current(self):
        if self.service.require_session(self.request)['id'] != self.session['id']:
            raise APIError(401, 'Your administrator session changed. Reopen room administration.')

    async def read(self, target):
        self.current()
        try:
            async with self.slots:
                self.current()
                async with asyncio.timeout(REQUEST_SECONDS):
                    path = '/_synapse/admin/v1/rooms/' + quote(target, safe='') + '/state'
                    async with self.service.http.get(self.service.config.synapse_url + path,
                            headers={'Authorization': 'Bearer ' + self.token}, allow_redirects=False) as response:
                        if response.status != 200:
                            return None, 'Native room state is unavailable.'
                        chunks, size = [], 0
                        async for chunk in response.content.iter_chunked(65536):
                            size += len(chunk)
                            if size > MAX_BYTES:
                                return None, 'Native room state exceeds the inspection byte limit.'
                            chunks.append(chunk)
                        value = json.loads(b''.join(chunks))
                self.current()
                return parse_state(value, target), None
        except (TimeoutError, ClientError):
            self.current()
            return None, 'Native room state could not be read within the request limit.'
        except (ValueError, UnicodeDecodeError):
            self.current()
            return None, 'Native room metadata is malformed or exceeds the inspection event limit.'

    async def page(self, target, offset, previous):
        root, error = await self.read(target)
        limits = {'pageSize': PAGE_SIZE, 'linksPerRoom': MAX_LINKS, 'depth': 8, 'displayedNodes': 100,
                  'stateBytes': MAX_BYTES, 'stateEvents': MAX_EVENTS, 'concurrency': CONCURRENCY, 'pageSeconds': PAGE_SECONDS}
        if root is None:
            return {'room': {'roomId': target, 'status': 'unavailable', 'reason': error}, 'links': [],
                    'revision': None, 'nextOffset': None, 'omittedLinks': 0, 'truncated': False, 'limits': limits}
        state, joined = root
        stamp = revision(state, joined)
        if previous and previous != stamp:
            raise APIError(409, 'Room relationships changed. Reload this hierarchy node before continuing.', 'HIERARCHY_CHANGED')
        all_links, omitted = candidates(state)
        page = all_links[:MAX_LINKS][offset:offset + PAGE_SIZE]

        async def linked(row):
            result = {'direction': row['direction'], 'roomId': row['roomId'], 'canonical': row['canonical']}
            if not row['valid']:
                return {**result, 'status': 'malformed', 'reason': 'The native routing link is malformed.'}
            if row['roomId'] == target:
                return {**result, 'status': 'cycle', 'reason': 'This room links to itself.'}
            other, problem = await self.read(row['roomId'])
            if other is None:
                return {**result, 'status': 'unavailable', 'reason': problem}
            other_state, members = other
            parent, child = (other_state, state) if row['direction'] == 'parent' else (state, other_state)
            parent_id, child_id = (row['roomId'], target) if row['direction'] == 'parent' else (target, row['roomId'])
            parent_create = parent[('m.room.create', '')]['content']
            reciprocal = (parent_create.get('type') == 'm.space' and
                          routing(parent.get(('m.space.child', child_id), {}).get('content', {})) and
                          routing(child.get(('m.space.parent', parent_id), {}).get('content', {}), True))
            if not reciprocal:
                return {**result, 'status': 'unconfirmed', 'reason': 'A current reciprocal Space relationship was not confirmed.'}
            return {**result, 'status': 'confirmed', 'room': metadata(row['roomId'], other_state, members)}

        links = await asyncio.gather(*(linked(row) for row in page))
        current, _ = await self.read(target)
        if current is None or revision(*current) != stamp:
            raise APIError(409, 'Room relationships changed or became unavailable. Reload this hierarchy node.', 'HIERARCHY_CHANGED')
        return {'room': metadata(target, state, joined), 'links': links, 'revision': stamp,
                'nextOffset': offset + PAGE_SIZE if offset + PAGE_SIZE < min(len(all_links), MAX_LINKS) else None,
                'omittedLinks': omitted, 'truncated': len(all_links) > MAX_LINKS, 'limits': limits}


async def inspect_hierarchy(request):
    service = request.app['service']
    session = await service.require_admin(request)
    service.require_session(request)
    target = identity(request.match_info['room_id'])
    offset = request.query.get('from', '0')
    previous = request.query.get('revision', '')
    if (not re.fullmatch(r'0|[1-9][0-9]{0,2}', offset) or int(offset) >= MAX_LINKS or int(offset) % PAGE_SIZE or
            (previous and not re.fullmatch(r'[a-f0-9]{64}', previous)) or (int(offset) and not previous)):
        raise APIError(400, 'Choose a valid hierarchy page and current revision.')
    service.store.rate('admin-hierarchy:' + session['id'], 120, 60)
    reader = Inspector(request, session)
    result = await reader.page(target, int(offset), previous)
    final = await service.require_admin(request)
    reader.current()
    if final['id'] != session['id']:
        raise APIError(401, 'Your administrator session changed.')
    result['checkedAt'] = int(time.time() * 1000)
    return web.json_response(result, headers={'Cache-Control': 'no-store'})


async def hierarchy(request):
    try:
        async with asyncio.timeout(PAGE_SECONDS):
            return await inspect_hierarchy(request)
    except TimeoutError:
        raise APIError(503, 'Hierarchy inspection exceeded its time limit. Try this node again.') from None


def register_routes(app):
    app.router.add_get('/api/admin/rooms/{room_id}/hierarchy', hierarchy)
