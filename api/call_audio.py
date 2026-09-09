"""Native durable audio intent and observed, device-scoped SFU enforcement."""
import asyncio
import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from types import SimpleNamespace
from urllib.parse import quote

from aiohttp import web

try:
    from .server import APIError, body_json
    from .room_authority import content, policy_model, room_authority, room_id, state, user_id
except ImportError:
    from server import APIError, body_json
    from room_authority import content, policy_model, room_authority, room_id, state, user_id

AUDIO = 'io.tavern.call.audio'
PREVIOUS = 'io.tavern.previous_event'


def enabled():
    value = os.environ.get('SFU_AUDIO_MODERATION_ENABLED', 'false')
    if value not in ('true', 'false'):
        raise ValueError('SFU_AUDIO_MODERATION_ENABLED must be true or false')
    return value == 'true'


class NativeReader:
    def __init__(self, service):
        self.service = service

    async def get_room_state(self, identity):
        return await state(self.service, room_id(identity))


@dataclass
class AudioSnapshot:
    room_id: str
    user_id: str
    state: dict
    scopes: tuple
    model: object
    policy: object
    local: dict
    effective: dict
    revision: str


async def audio_snapshot(service, identity, target, current=None, actor=None, model=None):
    identity, target = room_id(identity), user_id(target)
    model = policy_model(service) if model is None else model
    current = await state(service, identity) if current is None else current
    try:
        policy = model.AudioModerationPolicy({'audio_moderation_enabled': enabled()}, NativeReader(service), model)
        scopes = await policy.scopes(identity, current)
        local = model.audio_flags(current, target)
        effective = model.effective_audio(scopes, target)
        fingerprint = model.audio_scope_fingerprint(scopes, actor or target, target)
        # These additional current fields govern RTC admission even though they
        # do not authorize an audio-state write. Include them in the shared API
        # observation so the final read cannot ignore an archive or replacement.
        call_state = []
        for scope in scopes:
            for kind in ('io.tavern.channel', 'm.room.tombstone', 'io.tavern.server.eligibility'):
                item = scope.state.get((kind, ''))
                call_state.append((scope.room_id, kind, None if item is None else (getattr(item, 'event_id', None), getattr(item, 'sender', None), item.content)))
        revision = hashlib.sha256(json.dumps((fingerprint, call_state), ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()
        return AudioSnapshot(identity, target, current, scopes, model, policy, local, effective, revision)
    except (ValueError, AttributeError, TypeError):
        raise APIError(503, 'The current audio restrictions could not be safely checked.', 'CALL_AUDIO_UNAVAILABLE') from None


async def available(service):
    if not enabled():
        return False
    gateway = getattr(service, 'rtc_gateway', None)
    if gateway is None:
        return False
    try:
        return await gateway.moderator.audio_support()
    except APIError:
        return False


def previous(snapshot):
    item = snapshot.state.get((AUDIO, snapshot.model.audio_state_key(snapshot.user_id)))
    return item.event_id if item else None


def probe(snapshot, actor, flag):
    data = {'version': 1, **snapshot.local, PREVIOUS: previous(snapshot)}
    data[flag] = not data[flag]
    return SimpleNamespace(type=AUDIO, room_id=snapshot.room_id, state_key=snapshot.model.audio_state_key(snapshot.user_id),
                           sender=actor, content=data)


def permissions(snapshot, actor):
    return snapshot.policy.permissions_for(snapshot.state, snapshot.scopes, actor, snapshot.user_id)


class CallAudio:
    def __init__(self, service):
        enabled()  # Invalid deployment toggles must not silently disable checks.
        self.service = service

    async def authorized(self, request, identity, target):
        try:
            async with asyncio.timeout(12):
                return await self._authorized(request, identity, target)
        except asyncio.TimeoutError:
            raise APIError(503, 'Current audio permissions could not be checked in time.', 'CALL_AUDIO_UNAVAILABLE') from None

    async def _authorized(self, request, identity, target):
        service = self.service
        session = service.require_session(request)
        authority = await room_authority(service, session, identity)
        service.require_session(request)
        snapshot = await audio_snapshot(service, identity, target, authority.state, session['user_id'])
        service.require_session(request)
        # Do not reveal an arbitrary native account through privileged state.
        # A departed target is exposed only for an existing editable restriction.
        own = content(snapshot.state, 'm.room.member', target).get('membership') == 'join'
        rights = permissions(snapshot, session['user_id'])
        if not own and not (previous(snapshot) and any(rights.values())):
            raise APIError(403, 'Choose a current member or an existing restriction you can clear.')
        if not any(rights.values()) and not (own and target == session['user_id']):
            raise APIError(403, 'Your current native and server permissions do not allow audio moderation.')
        return snapshot

    async def checked(self, request, identity, target):
        before = await self.authorized(request, identity, target)
        latest = await self.authorized(request, identity, target)
        if before.revision != latest.revision:
            raise APIError(409, 'Call permissions changed. Reload these controls before continuing.', 'CALL_AUDIO_CHANGED')
        return latest

    def payload(self, request, snapshot, runtime_available, enforcement=None):
        actor = self.service.require_session(request)['user_id']
        scopes = []
        for scope in snapshot.scopes:
            if content(scope.state, 'm.room.member', actor).get('membership') != 'join':
                continue
            name = content(scope.state, 'm.room.name').get('name')
            scopes.append({'roomId': scope.room_id, 'name': name[:200] if isinstance(name, str) and name else scope.room_id,
                           'kind': 'server' if content(scope.state, 'm.room.create').get('type') == 'm.space' else 'channel'})
        return {'roomId': snapshot.room_id, 'userId': snapshot.user_id, 'available': runtime_available,
                'local': snapshot.local, 'effective': {key: snapshot.effective[key] for key in ('muted', 'deafened')},
                'permissions': permissions(snapshot, actor), 'eventId': previous(snapshot), 'revision': snapshot.revision,
                'scopes': scopes, 'enforcement': enforcement or {'status': 'pending', 'checkedAt': None, 'devices': 0}}

    async def enforcement(self, request, snapshot, reconcile=False):
        try:
            async with asyncio.timeout(16):
                return await self._enforcement(request, snapshot, reconcile)
        except asyncio.TimeoutError:
            self.service.require_session(request)
            return {'status': 'pending', 'checkedAt': None, 'devices': 0}

    async def _enforcement(self, request, snapshot, reconcile):
        """Only registry-bound devices count; no prefix guesses or SFU-only users.

        Read state for each of the bounded target admissions to determine whether
        a selected Space governs it. Unknown/failed scopes remain pending.
        """
        service, gateway = self.service, getattr(self.service, 'rtc_gateway', None)
        if gateway is None:
            return {'status': 'pending', 'checkedAt': None, 'devices': 0}
        rows = service.store.db.execute('SELECT * FROM rtc_admissions WHERE user_id=? LIMIT 129', (snapshot.user_id,)).fetchall()
        if len(rows) > 128:
            return {'status': 'pending', 'checkedAt': None, 'devices': 0}
        # The managed registry can prove individual current child connections,
        # but does not enumerate pre-upgrade/unregistered calls throughout an
        # entire Space. Keep its aggregate status pending rather than claiming
        # a complete server-wide census from a partial registry.
        matched, uncertain = [], content(snapshot.state, 'm.room.create').get('type') == 'm.space'
        for row in rows:
            try:
                current = await audio_snapshot(service, row['room_id'], snapshot.user_id)
                service.require_session(request)
                if any(scope.room_id == snapshot.room_id for scope in current.scopes):
                    matched.append((row, current.revision))
            except APIError as error:
                if error.status == 401:
                    raise
                uncertain = True
        if reconcile and matched:
            # Intent is already persisted. Timeout retains durable admissions for
            # the independent periodic worker; it is never a failed state save.
            for row, _ in matched:
                service.store.db.execute('UPDATE rtc_admissions SET audio_pending=1,next_check=0 WHERE room_alias=? AND identity=?', (row['room_alias'], row['identity']))
            semaphore = asyncio.Semaphore(4)
            async def check(row):
                async with semaphore:
                    await gateway.check_lease(row)
            try:
                await asyncio.wait_for(asyncio.gather(*(check(row) for row, _ in matched)), 12)
            except asyncio.TimeoutError:
                uncertain = True
            service.require_session(request)
        checked, devices, rejoin = [], 0, False
        # A selected channel can also have an older, unregistered connection.
        # Never count an unproven identity as another user's device or call the
        # complete inventory confirmed while any participant is unbound.
        identities = {row['room_id'] for row, _ in matched}
        if content(snapshot.state, 'm.room.create').get('type') != 'm.space':
            identities.add(snapshot.room_id)
        try:
            from .call_moderation import room_alias
        except ImportError:
            from call_moderation import room_alias
        for identity in sorted(identities):
            try:
                alias = room_alias(identity)
                inventory = (await gateway.moderator.sfu('ListParticipants', alias)).get('participants')
                service.require_session(request)
                if (not isinstance(inventory, list) or len(inventory) > 1000
                        or any(not isinstance(item, dict) or not isinstance(item.get('identity'), str) for item in inventory)):
                    uncertain = True
                    continue
                bound = {item['identity'] for item in service.store.db.execute('SELECT identity FROM rtc_admissions WHERE room_alias=? AND room_id=?', (alias, identity))}
                if len({item['identity'] for item in inventory}) != len(inventory) or any(item['identity'] not in bound for item in inventory):
                    uncertain = True
            except APIError as error:
                if error.status == 401:
                    raise
                uncertain = True
        for old, revision in matched:
            row = service.store.db.execute('SELECT * FROM rtc_admissions WHERE room_alias=? AND identity=?', (old['room_alias'], old['identity'])).fetchone()
            if row is None:
                continue  # Worker confirmed absence and released its binding.
            devices += 1
            rejoin = rejoin or bool(row['audio_rejoin'])
            if (row['revision'] != old['revision'] or row['audio_pending'] or row['audio_revision'] != revision
                    or row['audio_checked'] < time.time() - 30):
                uncertain = True
            else:
                checked.append(row['audio_checked'])
        # A token minted during inventory/state awaits is not part of this
        # observation. Let the next refresh count and verify that new device.
        initial_bindings = {(row['room_alias'], row['identity'], row['revision'], row['created'], row['session_id']) for row in rows}
        latest_bindings = service.store.db.execute('SELECT * FROM rtc_admissions WHERE user_id=? LIMIT 129', (snapshot.user_id,)).fetchall()
        if any((row['room_alias'], row['identity'], row['revision'], row['created'], row['session_id']) not in initial_bindings for row in latest_bindings):
            uncertain = True
        return {'status': 'pending' if uncertain else 'confirmed' if devices else 'idle',
                'checkedAt': int(min(checked) * 1000) if checked and not uncertain else None, 'devices': devices,
                'rejoinRequired': rejoin}

    async def read(self, request):
        self.service.require_session(request)
        identity, target = room_id(request.match_info['roomId']), user_id(request.match_info['userId'])
        runtime_available = await available(self.service)
        snapshot = await self.checked(request, identity, target)
        enforcement = await self.enforcement(request, snapshot)
        latest = await self.authorized(request, identity, target)
        if latest.revision != snapshot.revision:
            raise APIError(409, 'Call permissions changed. Reload these controls.', 'CALL_AUDIO_CHANGED')
        return web.json_response(self.payload(request, latest, runtime_available, enforcement), headers={'Cache-Control': 'no-store'})

    async def write(self, request):
        service = self.service
        session = service.require_session(request)
        identity, target = room_id(request.match_info['roomId']), user_id(request.match_info['userId'])
        data = await body_json(request, limit=4096)
        service.require_session(request)
        change = data.get('change')
        if (set(data) != {'change', 'revision', 'confirmation'} or not isinstance(change, dict) or len(change) != 1
                or not set(change) <= {'muted', 'deafened'} or any(type(value) is not bool for value in change.values())
                or not isinstance(data['revision'], str) or not re.fullmatch('[a-f0-9]{64}', data['revision'])
                or data['confirmation'] != target):
            raise APIError(400, 'Choose one audio change and confirm the exact Matrix account.')
        service.store.rate('call-audio:' + session['user_id'], 30, 60)
        runtime_available = await available(service)
        snapshot = await self.checked(request, identity, target)
        if snapshot.revision != data['revision']:
            raise APIError(409, 'Call permissions changed. Reload before saving.', 'CALL_AUDIO_CHANGED')
        flag = next(iter(change))
        event = probe(snapshot, session['user_id'], flag)
        event.content[flag] = change[flag]
        if not snapshot.policy.may_write(event, snapshot.state, snapshot.scopes):
            raise APIError(403, 'Your current permissions do not allow this audio change.')
        if change[flag] and not runtime_available:
            raise APIError(503, 'The configured SFU audio moderation service is unavailable.', 'CALL_AUDIO_UNAVAILABLE')
        service.require_session(request)
        # Exactly one native PUT. Its required previous-event CAS remains the
        # final authority even if another moderator saves after our last read.
        response = await service.matrix('PUT', '/_matrix/client/v3/rooms/' + quote(identity, safe='') + '/state/' + AUDIO + '/' + quote(event.state_key, safe=''),
                                        token=service.store.open(session['token']), body=event.content)
        service.require_session(request)
        event_id = response.get('event_id')
        latest = await self.authorized(request, identity, target)
        if (not isinstance(event_id, str) or not event_id.startswith('$') or previous(latest) != event_id
                or latest.local != {key: event.content[key] for key in ('muted', 'deafened')}):
            raise APIError(409, 'The native save could not be confirmed. Reload before trying another change.', 'CALL_AUDIO_CHANGED')
        service.audit(session['user_id'], 'call.audio_saved', target, identity)
        enforcement = await self.enforcement(request, latest, reconcile=True)
        final = await self.authorized(request, identity, target)
        if final.revision != latest.revision:
            enforcement = {'status': 'pending', 'checkedAt': None, 'devices': enforcement['devices']}
        return web.json_response({'saved': True, **self.payload(request, final, runtime_available, enforcement)}, headers={'Cache-Control': 'no-store'})


def register_routes(app):
    manager = CallAudio(app['service'])
    app['service'].call_audio = manager
    app.router.add_get('/api/calls/audio/{roomId}/{userId}', manager.read)
    app.router.add_post('/api/calls/audio/{roomId}/{userId}', manager.write)
