"""Eligible private-channel discovery, with native membership as the authority."""
import asyncio
from types import SimpleNamespace

from aiohttp import ClientTimeout, web

try:
    from .server import APIError
    from .room_authority import content, room_authority, room_id, state
except ImportError:
    from server import APIError
    from room_authority import content, room_authority, room_id, state


async def available(service):
    try:
        async with service.http.get(service.config.synapse_url + '/_tavern/channel-admission',
                                    timeout=ClientTimeout(total=5), allow_redirects=False,
                                    headers={'Cache-Control': 'no-cache'}) as response:
            if response.status != 200:
                return False
            raw = await response.content.read(4097)
            if len(raw) > 4096:
                return False
            import json
            value = json.loads(raw)
            return isinstance(value, dict) and type(value.get('version')) is int and value['version'] == 1 and value.get('ready') is True
    except Exception:
        return False


async def capability(request):
    service = request.app['service']
    service.require_session(request)
    ready = await available(service)
    service.require_session(request)
    return web.json_response({'version': 1, 'available': ready}, headers={'Cache-Control': 'no-store'})


async def catalog(request):
    service = request.app['service']
    session = service.require_session(request)
    server = room_id(request.match_info['server'])
    if set(request.query) - {'after'} or len(request.query.getall('after', [])) > 1:
        raise APIError(400, 'Choose a valid channel page.')
    after = request.query.get('after', '')
    if after:
        room_id(after)
    try:
        async with asyncio.timeout(15):
            authority = await room_authority(service, session, server)
            current, model, actor = authority.state, authority.model, session['user_id']
            creation = content(current, 'm.room.create')
            policy = content(current, model.POLICY)
            if creation.get('type') != 'm.space' or creation.get('m.federate') is not False or not model.valid_policy(policy):
                raise APIError(403, 'This server does not support private-channel discovery.')
            if policy.get('channelAdmissionVersion') != 1:
                return web.json_response({'channels': [], 'next': None}, headers={'Cache-Control': 'no-store'})
            if not await available(service):
                raise APIError(503, 'Private-channel access is not ready. Ask the administrator to update and restart Synapse.')
            candidates = sorted(identity for identity in policy['channelAdmissions'] if identity > after)

            async def read(identity):
                return await state(service, room_id(identity))
            admission = model.ChannelAdmissionPolicy(SimpleNamespace(get_room_state=read, is_mine=lambda user: user == actor), model.valid_policy)
            rows = []
            # Page the inspected native candidates, including denied entries.
            # This bounds privileged reads without disclosing a denied name.
            for identity in candidates[:25]:
                channel = await read(identity)
                if (not content(current, 'm.space.child', identity).get('via')
                        or content(channel, 'm.space.parent', server).get('canonical') is not True
                        or not content(channel, 'm.space.parent', server).get('via')
                        or content(channel, 'm.room.create').get('type') in {'m.space', 'io.tavern.private_thread'}
                        or content(channel, 'm.room.encryption').get('algorithm') != 'm.megolm.v1.aes-sha2'
                        or content(channel, 'io.tavern.channel').get('archived') is True
                        or ('m.room.tombstone', '') in channel):
                    continue
                reason = await admission.denial(identity, channel, actor)
                if reason:
                    if reason != model.ADMISSION_DENIED:
                        raise APIError(503, 'Private-channel access changed or could not be checked. Refresh the channel list.')
                    continue
                membership = content(channel, 'm.room.member', actor).get('membership')
                if membership == 'ban':
                    continue
                name = content(channel, 'm.room.name').get('name')
                kind = content(channel, 'io.tavern.channel').get('kind', 'text')
                if kind not in {'text', 'voice', 'video', 'forum', 'announcement', 'rules', 'media', 'read-only'}:
                    kind = 'text'
                rows.append({'id': identity, 'name': name[:200] if isinstance(name, str) else 'Private channel', 'kind': kind,
                             'joined': membership == 'join'})
            # An actor leaving or an owner changing the audience during the
            # scan invalidates the complete response before any names leave.
            latest = await room_authority(service, session, server)
            service.require_session(request)
            if content(latest.state, model.POLICY) != policy:
                raise APIError(409, 'Private-channel access changed. Refresh the channel list.')
            return web.json_response({'channels': rows, 'next': candidates[24] if len(candidates) > 25 else None}, headers={'Cache-Control': 'no-store'})
    except asyncio.TimeoutError:
        raise APIError(503, 'Private-channel discovery took too long. Try again shortly.') from None


def register_routes(app):
    app.add_routes([web.get('/api/channels/admission/capability', capability),
                    web.get('/api/servers/{server}/channels/available', catalog)])
