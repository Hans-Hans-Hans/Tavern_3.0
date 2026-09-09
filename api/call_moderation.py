"""Room-authorized removal from Matrix and the pinned self-hosted MatrixRTC SFU.

Mapping uses the managed gateway's signed admission registry, with a verified
legacy /sfu/get room-state fallback for deployments upgrading existing calls:
https://github.com/element-hq/lk-jwt-service/blob/v0.6.0/handler.go
https://github.com/element-hq/lk-jwt-service/blob/v0.6.0/helper.go
LiveKit's documented Twirp RoomService protocol uses a room-scoped admin JWT.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import quote

from aiohttp import ClientError, ClientTimeout, web

try:
    from .server import APIError, body_json
except ImportError:
    from server import APIError, body_json

SUPPORTED_AUTH_IMAGE = 'ghcr.io/element-hq/lk-jwt-service:0.6.0'
CONFIRMATION = 'REMOVE FROM CHANNEL AND CALL'


def room_alias(room_id):
    # Go json.Marshal escapes HTML and line separators; match byte-for-byte.
    payload = json.dumps([room_id, 'm.call#ROOM'], ensure_ascii=False, separators=(',', ':'))
    for source, target in (('&', '\\u0026'), ('<', '\\u003c'), ('>', '\\u003e'), ('\u2028', '\\u2028'), ('\u2029', '\\u2029')):
        payload = payload.replace(source, target)
    return base64.b64encode(hashlib.sha256(payload.encode()).digest()).decode().rstrip('=')


def admin_token(key, secret, room, now=None):
    now = int(time.time() if now is None else now)
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).decode().rstrip('=')
    header = encode({'alg': 'HS256', 'typ': 'JWT'})
    payload = encode({'iss': key, 'sub': 'tavern-call-moderation', 'nbf': now - 5, 'exp': now + 60, 'video': {'roomAdmin': True, 'room': room}})
    message = header + '.' + payload
    signature = base64.urlsafe_b64encode(hmac.new(secret.encode(), message.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return message + '.' + signature


def target_identities(events, participants, target):
    """Bind legacy SFU identities to server-owned room state, never a user prefix."""
    users = {event.get('state_key') for event in events if isinstance(event, dict) and event.get('type') == 'm.room.member' and isinstance(event.get('content'), dict) and event['content'].get('membership') == 'join'}
    identities = set()
    for event in events:
        if not isinstance(event, dict) or event.get('type') != 'org.matrix.msc3401.call.member' or event.get('sender') != target:
            continue
        content = event.get('content', {})
        if not isinstance(content, dict):
            continue
        device = content.get('device_id')
        if content.get('application') != 'm.call' or content.get('call_id') not in ('', 'ROOM') or not isinstance(device, str) or not 1 <= len(device) <= 512 or any(ord(c) < 32 for c in device):
            continue
        identity = target + ':' + device
        if any(isinstance(user, str) and user != target and identity.startswith(user + ':') for user in users):
            raise APIError(503, 'This conference has ambiguous legacy identities. An administrator must review the call configuration.')
        identities.add(identity)
    return sorted({participant['identity'] for participant in participants} & identities)


def mapped_targets(events, participants, target, bindings):
    """Resolve exact identities; an opaque SFU name is never a user prefix."""
    users = {event.get('state_key') for event in events if isinstance(event, dict) and event.get('type') == 'm.room.member' and isinstance(event.get('content'), dict) and event['content'].get('membership') == 'join'}
    present = {participant['identity'] for participant in participants}
    owners = {}
    for event in events:
        if not isinstance(event, dict) or event.get('type') != 'org.matrix.msc3401.call.member' or event.get('sender') not in users:
            continue
        user, content = event['sender'], event.get('content')
        if not isinstance(content, dict):
            continue
        device = content.get('device_id')
        if content.get('application') != 'm.call' or content.get('call_id') not in ('', 'ROOM') or not isinstance(device, str) or not 1 <= len(device) <= 512 or any(ord(c) < 32 for c in device):
            continue
        identity = user + ':' + device
        if identity not in present:
            continue
        # Check every possible legacy user delimiter against actual room users,
        # including server names with explicit ports; never guess by startswith.
        if any(identity[:index] in users and identity[:index] != user for index, char in enumerate(identity) if char == ':'):
            raise APIError(503, 'The conference contains an ambiguous legacy identity.')
        owners[identity] = user
    for binding in bindings:
        identity, user = binding['identity'], binding['user_id']
        if identity in owners and owners[identity] != user:
            raise APIError(503, 'The conference identity could not be verified.')
        owners[identity] = user
    if present - owners.keys():
        raise APIError(503, 'A conference participant has no verified identity. Wait for the call to reconnect before trying again.')
    # Include issued identities that have not appeared in the SFU inventory yet:
    # their connection may have been in flight when the moderator started.
    return sorted(identity for identity, user in owners.items() if user == target)


class CallModerator:
    def __init__(self, service):
        self.service = service
        self.directory = Path(os.environ.get('CALL_CONFIG_DIR', '/call-config'))

    def credentials(self):
        if os.environ.get('CALLS_ENABLED') != 'true' or os.environ.get('RTC_AUTH_IMAGE', SUPPORTED_AUTH_IMAGE) != SUPPORTED_AUTH_IMAGE:
            raise APIError(503, 'Call moderation requires the configured, supported self-hosted call services.', 'CALL_MODERATION_UNAVAILABLE')
        try:
            key = (self.directory / 'livekit_key').read_text().strip()
            secret = (self.directory / 'livekit_secret').read_text().strip()
        except OSError:
            raise APIError(503, 'Call moderation credentials are unavailable.', 'CALL_MODERATION_UNAVAILABLE') from None
        if not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', key) or len(secret) < 24 or len(secret) > 512 or any(ord(c) < 32 for c in secret):
            raise APIError(503, 'Call moderation credentials need administrator attention.', 'CALL_MODERATION_UNAVAILABLE')
        return key, secret

    async def sfu(self, method, room, values=None):
        if method not in ('ListParticipants', 'RemoveParticipant', 'UpdateParticipant'):
            raise ValueError('Unsupported call moderation operation')
        key, secret = self.credentials()
        try:
            async with self.service.http.post('http://livekit:7880/twirp/livekit.RoomService/' + method,
                    json={'room': room, **(values or {})}, headers={'Authorization': 'Bearer ' + admin_token(key, secret, room)},
                    allow_redirects=False, auto_decompress=True, timeout=ClientTimeout(total=8)) as response:
                chunks = bytearray()
                async for chunk in response.content.iter_chunked(16384):
                    chunks.extend(chunk)
                    if len(chunks) > 512 * 1024:
                        raise APIError(502, 'The call service returned an oversized response.', 'CALL_SERVICE_UNAVAILABLE')
                data = json.loads(chunks) if chunks else {}
                if response.status == 404 and isinstance(data, dict) and data.get('code') == 'not_found':
                    return {'participants': []} if method == 'ListParticipants' else {}
                if response.status != 200 or not isinstance(data, dict):
                    raise APIError(502, 'The call service could not complete the operation.', 'CALL_SERVICE_UNAVAILABLE')
                return data
        except (ClientError, asyncio.TimeoutError, ValueError, UnicodeError):
            raise APIError(502, 'The call service is unavailable. Try again shortly.', 'CALL_SERVICE_UNAVAILABLE') from None

    async def audio_support(self):
        """A flag or unknown JSON field cannot prove the SFU implements deafen."""
        self.credentials()
        try:
            async with self.service.http.get('http://livekit:7880/tavern/sfu/audio-permissions',
                    allow_redirects=False, timeout=ClientTimeout(total=2)) as response:
                raw = bytearray()
                async for chunk in response.content.iter_chunked(1024):
                    raw.extend(chunk)
                    if len(raw) > 1024:
                        raise ValueError()
                def unique(pairs):
                    result = {}
                    for key, item in pairs:
                        if key in result:
                            raise ValueError()
                        result[key] = item
                    return result
                value = json.loads(raw, object_pairs_hook=unique)
                if response.status != 200 or response.content_type != 'application/json' or not isinstance(value, dict) or set(value) != {'version'} or type(value['version']) is not int or value['version'] != 1:
                    raise ValueError()
        except (ClientError, asyncio.TimeoutError, ValueError, UnicodeError):
            raise APIError(503, 'The running SFU audio capability could not be verified.', 'CALL_AUDIO_UNAVAILABLE') from None
        return True

    async def capabilities(self, request):
        self.service.require_session(request)
        try:
            from .room_authority import policy_model
        except ImportError:
            from room_authority import policy_model
        try:
            controls = hasattr(policy_model(self.service), 'AudioModerationPolicy')
        except APIError:
            controls = False
        try:
            self.credentials()
        except APIError as error:
            return web.json_response({'available': False, 'audioModerationAvailable': False, 'audioModerationControls': controls, 'reason': error.message})
        try:
            from .call_audio import available
        except ImportError:
            from call_audio import available
        audio_available = await available(self.service)
        self.service.require_session(request)
        return web.json_response({'available': True, 'audioModerationAvailable': audio_available, 'audioModerationControls': controls, 'action': 'remove_from_channel_and_call'})

    def bindings(self, room, alias):
        if getattr(self.service, 'rtc_gateway', None) is None:
            return []
        return self.service.store.db.execute('SELECT identity,user_id FROM rtc_admissions WHERE room_alias=? AND room_id=?', (alias, room)).fetchall()

    async def disconnect(self, alias, identity):
        gateway = getattr(self.service, 'rtc_gateway', None)
        if gateway is None:
            await self.sfu('RemoveParticipant', alias, {'identity': identity})
        else:
            # Coordinate with token publication, signaling admission and the
            # background revocation worker for this exact participant only.
            async with gateway.lock(alias, identity):
                await self.sfu('RemoveParticipant', alias, {'identity': identity})

    async def remove(self, request):
        session = self.service.require_session(request)
        data = await body_json(request)
        self.service.require_session(request)
        room_id, target = data.get('roomId'), data.get('userId')
        if not isinstance(room_id, str) or not re.fullmatch(r'![^\s/\\?#]{1,254}', room_id) or not isinstance(target, str) or not re.fullmatch(r'@[^\s/\\?#]{1,254}:[^\s/\\?#]{1,254}', target):
            raise APIError(400, 'Choose a valid channel and participant.')
        if data.get('confirmation') != CONFIRMATION:
            raise APIError(400, 'Confirm that this removes the participant from both the channel and conference.')
        if target == session['user_id']:
            raise APIError(400, 'Use Leave conference to leave your own call.')
        self.credentials()  # Validate scope before any membership changes.
        self.service.store.rate('call-remove:' + session['user_id'], 12, 60)
        prefix = '/_matrix/client/v3/rooms/' + quote(room_id, safe='')
        token = self.service.store.open(session['token'])
        membership = await self.service.matrix('GET', prefix + '/state/m.room.member/' + quote(session['user_id'], safe=''), token=token)
        encryption = await self.service.matrix('GET', prefix + '/state/m.room.encryption/', token=token)
        if membership.get('membership') != 'join' or encryption.get('algorithm') != 'm.megolm.v1.aes-sha2':
            raise APIError(403, 'Join this encrypted channel before moderating its conference.')
        alias = room_alias(room_id)
        inventory = await self.sfu('ListParticipants', alias)
        participants = inventory.get('participants', [])
        if not isinstance(participants, list) or len(participants) > 1000 or any(not isinstance(p, dict) or not isinstance(p.get('identity'), str) for p in participants):
            raise APIError(502, 'The call participant inventory could not be verified.')
        state = await self.service.matrix('GET', '/_synapse/admin/v1/rooms/' + quote(room_id, safe='') + '/state', token=await self.service.service_token())
        events = state.get('state')
        if not isinstance(events, list) or len(events) > 50000:
            raise APIError(502, 'The conference membership inventory could not be verified.')
        identities = mapped_targets(events, participants, target, self.bindings(room_id, alias))
        reason = data.get('reason', 'Removed from channel and conference by a moderator.')
        if not isinstance(reason, str) or len(reason) > 500:
            raise APIError(400, 'Use a moderation reason of at most 500 characters.')
        # Synapse authorizes the actual native kick, including Tavern roles and rank.
        self.service.require_session(request)
        await self.service.matrix('POST', prefix + '/kick', {'user_id': target, 'reason': reason}, token=token)
        disconnected = 0
        try:
            # Include scoped tokens published while native kick was in flight.
            identities = sorted(set(identities) | set(mapped_targets(events, participants, target, self.bindings(room_id, alias))))
            for identity in identities:
                await self.disconnect(alias, identity)
                disconnected += 1
            # Recheck after the kick: another device may have joined between the
            # first inventory and native membership change. Never claim its
            # media is disconnected on the strength of the earlier snapshot.
            remaining = (await self.sfu('ListParticipants', alias)).get('participants', [])
            if not isinstance(remaining, list) or len(remaining) > 1000 or any(not isinstance(participant, dict) or not isinstance(participant.get('identity'), str) for participant in remaining):
                raise APIError(502, 'The participant disconnect could not be confirmed.')
            still_target = set(mapped_targets(events, remaining, target, self.bindings(room_id, alias))) & {participant['identity'] for participant in remaining}
            if still_target:
                raise APIError(502, 'The participant disconnect could not be confirmed.')
        except APIError:
            self.service.audit(session['user_id'], 'call.remove.partial', target, room_id)
            return web.json_response({'membershipRemoved': True, 'mediaDisconnectConfirmed': False, 'disconnectedDevices': disconnected,
                'message': 'Channel membership was removed, but the call service did not confirm every media disconnect. Ask an instance administrator to check the call service.'})
        self.service.audit(session['user_id'], 'call.remove', target, room_id)
        return web.json_response({'membershipRemoved': True, 'mediaDisconnectConfirmed': True, 'disconnectedDevices': disconnected})


def register_routes(app):
    moderator = CallModerator(app['service'])
    app['call_moderator'] = moderator
    app.router.add_get('/api/calls/capabilities', moderator.capabilities)
    app.router.add_post('/api/calls/remove', moderator.remove)
