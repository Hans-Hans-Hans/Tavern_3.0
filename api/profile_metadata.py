"""Minimal authoritative metadata for self and current shared-room members."""
from collections import OrderedDict
import time
from urllib.parse import quote

from aiohttp import web

try:
    from .server import APIError
    from .room_authority import room_id, user_id
except ImportError:
    from server import APIError
    from room_authority import room_id, user_id


def creation_time(value):
    # The user detail API historically returns seconds; list APIs return ms.
    # Normalize only a positive native timestamp, never Tavern's first-login time.
    if type(value) is not int or value <= 0:
        return None
    result = value * 1000 if value < 1_000_000_000_000 else value
    return result if result <= (time.time() + 86400) * 1000 else None


async def shared_membership(service, session, target, identity):
    token = service.store.open(session['token'])
    prefix = '/_matrix/client/v3/rooms/' + quote(identity, safe='') + '/state/m.room.member/'
    for user in (session['user_id'], target):
        status, member = await service.matrix('GET', prefix + quote(user, safe=''), token=token, expected=False)
        if status != 200 or member.get('membership') != 'join':
            raise APIError(403, 'Account details are available only to current members of a shared conversation.')


async def detail(request):
    service = request.app['service']; session = service.require_session(request)
    target = user_id(request.match_info['user_id'])
    service.store.rate('profile-metadata:' + session['user_id'], 60, 60)
    if target != session['user_id']:
        await shared_membership(service, session, target, room_id(request.query.get('roomId')))
    cache = service.profile_metadata_cache
    current = cache.pop(target, None)
    if current and current[0] > time.monotonic():
        cache[target] = current
        created = current[1]
    else:
        status, native = await service.matrix('GET', '/_synapse/admin/v2/users/' + quote(target, safe=''), token=await service.service_token(), expected=False)
        if status not in (200, 400, 404):
            raise APIError(503, 'The account creation date is temporarily unavailable.')
        created = creation_time(native.get('creation_ts')) if status == 200 else None
        cache[target] = (time.monotonic() + (3600 if created else 60), created)
        while len(cache) > 512:
            cache.popitem(last=False)
    service.require_session(request)
    return web.json_response({'userId': target, 'createdAt': created, 'source': 'homeserver' if created else None}, headers={'Cache-Control': 'no-store'})


def register_routes(app):
    app['service'].profile_metadata_cache = OrderedDict()
    app.add_routes([web.get('/api/profiles/{user_id}/account', detail)])
