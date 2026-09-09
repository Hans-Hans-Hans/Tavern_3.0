"""Temporary bans enforced by Synapse state, using ordinary moderator authority."""
import time
import asyncio
from urllib.parse import quote
from aiohttp import web, ClientError

try:
    from .server import APIError, body_json, text_value
    from .room_authority import room_authority, user_id, content
except ImportError:
    from server import APIError, body_json, text_value
    from room_authority import room_authority, user_id, content

TEMPBAN = 'io.tavern.tempban'
MAX_SECONDS = 28 * 86400


def restriction(current, target, identity, model):
    event = model.member_state_event(current, TEMPBAN, target)
    data = event.content if event else {}
    until = data.get('until', 0)
    valid = data.get('version') == 1 and type(until) is int and until >= 0
    return {'roomId': identity, 'targetId': target, 'eventId': event.event_id if event else None,
        'until': until if valid else None, 'active': bool(event and (not valid or until > int(time.time() * 1000))),
        'reason': data.get('reason', '') if isinstance(data.get('reason', ''), str) else '', 'actor': event.sender if event else None}


async def temporary_bans(request):
    service = request.app['service']; session = service.require_session(request)
    if request.method == 'GET':
        target = user_id(request.query.get('targetId'))
        authority = await room_authority(service, session, request.query.get('roomId')); authority.require('ban', native='ban')
        try: authority.model.member_state_key(target)
        except ValueError: raise APIError(400, 'Choose a valid Matrix account of at most 255 UTF-8 bytes.') from None
        service.require_session(request)
        return web.json_response({'restriction': restriction(authority.state, target, authority.room_id, authority.model),
            'inherited': [restriction(parent, target, identity, authority.model) for identity, _, parent in authority.policies if identity != authority.room_id and authority.model.member_state_event(parent, TEMPBAN, target)],
            'membership': content(authority.state, 'm.room.member', target).get('membership', 'leave'),
            'scope': 'server' if any(identity == authority.room_id for identity, _, _ in authority.policies) else 'room'})
    data = await body_json(request); target = user_id(data.get('targetId'))
    if data.get('confirmation') != target:
        raise APIError(400, 'Confirm the exact member ID before changing this temporary ban.')
    action = data.get('action')
    if action not in ('apply', 'lift'):
        raise APIError(400, 'Choose whether to apply or lift a temporary ban.')
    seconds = data.get('durationSeconds')
    if action == 'apply' and (type(seconds) is not int or not 60 <= seconds <= MAX_SECONDS):
        raise APIError(400, 'Choose a temporary ban lasting from one minute to 28 days.')
    reason = text_value(data.get('reason', ''), 500).strip()
    if action == 'apply' and not reason:
        raise APIError(400, 'Explain why this temporary ban is needed. The reason is visible in room state.')
    if 'previousEventId' not in data or data['previousEventId'] is not None and not isinstance(data['previousEventId'], str):
        raise APIError(400, 'Review the current temporary ban before changing it.')
    service.store.rate('temporary-ban:' + session['user_id'], 30, 3600)
    authority = await room_authority(service, session, data.get('roomId')); authority.require('ban', native='ban', target=target)
    try: target_key = authority.model.member_state_key(target)
    except ValueError: raise APIError(400, 'Choose a valid Matrix account of at most 255 UTF-8 bytes.') from None
    previous = authority.model.member_state_event(authority.state, TEMPBAN, target); previous_id = previous.event_id if previous else None
    if data['previousEventId'] != previous_id:
        raise APIError(409, 'This temporary ban changed. Refresh it before submitting again.')
    membership = content(authority.state, 'm.room.member', target).get('membership', 'leave')
    if membership == 'ban' and action == 'apply':
        raise APIError(409, 'This member has a permanent Matrix ban. Review that ban separately before applying a temporary restriction.')
    session = service.require_session(request)
    token = service.store.open(session['token'])
    prefix = '/_matrix/client/v3/rooms/' + quote(authority.room_id, safe='')
    until = int(time.time() * 1000) + seconds * 1000 if action == 'apply' else 0
    payload = {'version': 1, 'until': until, 'reason': reason, 'io.tavern.previous_event': previous_id}
    # Native state authorization and current Synapse role checks apply to this
    # write. The service account is used only for the read-only authority view.
    try:
        result = await service.matrix('PUT', prefix + '/state/' + TEMPBAN + '/' + quote(target_key, safe=''), payload, token=token)
    except (ClientError, asyncio.TimeoutError):
        raise APIError(502, 'The homeserver did not confirm this temporary ban change. Refresh its current state before trying again.') from None
    service.audit(session['user_id'], 'temporary_ban_applied' if until else 'temporary_ban_lifted', target, authority.room_id + ' until:' + str(until))
    removed = membership not in ('join', 'invite', 'knock')
    response = {'restrictionApplied': bool(until), 'until': until, 'eventId': result.get('event_id'),
        'membershipRemoved': removed, 'scope': 'server' if any(identity == authority.room_id for identity, _, _ in authority.policies) else 'room',
        'message': 'The temporary restriction was lifted. This does not invite the member back or change any permanent Matrix ban.'}
    if until:
        response['message'] = 'The temporary restriction is active until the displayed expiry. The member can rejoin after it expires if the room permits admission.'
        if not removed:
            try:
                service.require_session(request)
                await service.matrix('POST', prefix + '/kick', {'user_id': target, 'reason': reason}, token=token)
                response['membershipRemoved'] = True
            except (APIError, ClientError, asyncio.TimeoutError):
                # Applying state and changing native membership cannot be one
                # transaction. Preserve the restriction and report the outcome.
                response['message'] = 'The temporary restriction is active, but room membership removal was not confirmed. The member may still read this room. Use Remove from channel after checking your current kick permission.'
                service.audit(session['user_id'], 'temporary_ban_membership_unconfirmed', target, authority.room_id)
        if response['scope'] == 'server':
            response['message'] += ' Existing child-channel membership and readable history remain; inherited restrictions prevent writes and admission in canonical child channels.'
        response['message'] += ' Existing media connections are not forcibly disconnected by this action; use the call moderation controls when needed.'
    return web.json_response(response)


def register_routes(app):
    app.add_routes([web.get('/api/moderation/temporary-bans', temporary_bans), web.post('/api/moderation/temporary-bans', temporary_bans)])
