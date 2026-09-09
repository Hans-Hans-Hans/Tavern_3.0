"""Recipient-owned extra restrictions on invitations from shared server members."""
import asyncio
import hashlib
import json
import re
from urllib.parse import quote

from aiohttp import web

try:
    from .server import APIError, body_json
    from .room_authority import policy_model
    from .invitation_privacy import POLICY, MODES, SETTINGS_TIMEOUT
except ImportError:
    from server import APIError, body_json
    from room_authority import policy_model
    from invitation_privacy import POLICY, MODES, SETTINGS_TIMEOUT


def revision(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


async def settings(request):
    service = request.app['service']
    session = service.require_session(request)
    actor = session['user_id']
    try:
        async with asyncio.timeout(SETTINGS_TIMEOUT):
            async with service.user_locks.setdefault(actor, asyncio.Lock()):
                return await settings_locked(request)
    except asyncio.TimeoutError:
        raise APIError(504, 'Saving or loading server invitation preferences timed out. Reload the current settings before retrying.') from None


async def settings_locked(request):
    service = request.app['service']
    session = service.require_session(request)
    actor = session['user_id']
    service.require_session(request)
    token = service.store.open(session['token'])
    path = '/_matrix/client/v3/user/' + quote(actor, safe='') + '/account_data/' + POLICY
    status, current = await service.matrix('GET', path, token=token, expected=False)
    service.require_session(request)
    if status not in (200, 404) or status == 200 and not isinstance(current, dict):
        raise APIError(502, 'Your server invitation preferences could not be read.')
    current = current if status == 200 else {}
    raw = current.get('serverInvitations', {})
    parse = policy_model(service).InvitationPolicy.server_rules
    stored = parse(raw)
    if request.method == 'PUT':
        data = await body_json(request)
        service.require_session(request)
        if set(data) != {'servers', 'revision'} or parse(data['servers']) is None or not isinstance(data['revision'], str) or not re.fullmatch('[0-9a-f]{64}', data['revision']):
            raise APIError(400, 'Choose up to 200 valid server invitation restrictions.')
        if data['revision'] != revision(raw):
            raise APIError(409, 'Your server invitation preferences changed. Reload before saving.')
        service.store.rate('server-invitation-privacy:' + actor, 10, 60)
        changed = [server for server, mode in data['servers'].items() if (stored or {}).get(server) != mode]
        if changed:
            joined = await service.matrix('GET', '/_matrix/client/v3/joined_rooms', token=token)
            service.require_session(request)
            joined = joined.get('joined_rooms') if isinstance(joined, dict) else None
            if not isinstance(joined, list) or len(joined) > 4096 or not set(changed).issubset(joined):
                raise APIError(403, 'Join each selected server before changing its invitation restriction.')
            for server in changed:
                create = await service.matrix('GET', '/_matrix/client/v3/rooms/' + quote(server, safe='') + '/state/m.room.create', token=token)
                service.require_session(request)
                if not isinstance(create, dict) or create.get('type') != 'm.space':
                    raise APIError(400, 'Choose a server, rather than a conversation channel.')
        # Account data lacks native CAS. Serialize managed changes and
        # recheck the observed document after upstream membership awaits.
        fresh_status, fresh = await service.matrix('GET', path, token=token, expected=False)
        service.require_session(request)
        fresh = {} if fresh_status == 404 else fresh
        if fresh_status not in (200, 404) or fresh != current:
            raise APIError(409, 'Your conversation preferences changed. Reload before saving.')
        current = {**current, 'version': 1, 'serverInvitations': data['servers']}
        await service.matrix('PUT', path, current, token=token)
        service.require_session(request)
        raw = data['servers']; stored = dict(raw)
        service.audit(actor, 'server_invitation_privacy_changed', actor)
    mode = current.get('invitations', 'everyone')
    return web.json_response({'servers': stored or {}, 'invalid': stored is None, 'revision': revision(raw),
        'invitations': mode if mode in MODES else 'nobody'})


def register_routes(app):
    app.add_routes([web.get('/api/social/server-invitation-privacy', settings), web.put('/api/social/server-invitation-privacy', settings)])
