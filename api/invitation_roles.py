"""Default invitation roles use the deployed policy and the issuer's real token."""
import asyncio
import copy
import time
from urllib.parse import quote
try:
    from .server import APIError
    from .room_authority import policy_model, state, content, power
except ImportError:
    from server import APIError
    from room_authority import policy_model, state, content, power


def role_ids(value):
    if not isinstance(value, list) or len(value) > 20 or any(not isinstance(item, str) for item in value):
        raise APIError(400, 'Select at most 20 default roles.')
    if len(set(value)) != len(value) or 'everyone' in value:
        raise APIError(400, 'Select each optional role once. The default member role is already inherited.')
    return value


async def checked_roles(service, room_id, issuer, requested, target=None):
    requested = role_ids(requested)
    if not requested: return None
    if service.store.account(issuer).get('access_blocked'):
        raise APIError(403, 'The invitation issuer is suspended.')
    model, current = policy_model(service), await state(service, room_id)
    if service.store.account(issuer).get('access_blocked'):
        raise APIError(403, 'The invitation issuer is suspended.')
    policy = content(current, model.POLICY)
    create = content(current, 'm.room.create')
    if create.get('type') != 'm.space' or create.get('m.federate', True) or not model.valid_policy(policy):
        raise APIError(400, 'Default roles are available on servers with an enabled role policy.')
    if content(current, 'm.room.member', issuer).get('membership') != 'join':
        raise APIError(403, 'The invitation issuer no longer belongs to this server.')
    powers = content(current, 'm.room.power_levels')
    threshold = powers.get('events', {}).get(model.POLICY, powers.get('state_default', 50))
    grants, rank = model.permissions(policy, issuer), model.rank(policy, issuer)
    if type(threshold) is not int or power(current, issuer) < threshold or 'manage_roles' not in grants:
        raise APIError(403, 'The invitation issuer cannot assign server roles.')
    roles = {role['id']: role for role in policy['roles']}
    for identity in requested:
        role = roles.get(identity)
        if not role or role['position'] >= rank or not set(role['permissions']) <= grants:
            raise APIError(403, 'One of the invitation roles changed or is above the issuer’s current authority.')
    if target is not None:
        if target == issuer or model.rank(policy, target) >= rank or power(current, target) >= power(current, issuer):
            raise APIError(403, 'Invitation roles cannot change the issuer or an equal or higher member.')
        if content(current, 'm.room.member', target).get('membership') != 'join':
            raise APIError(409, 'Join the server before receiving invitation roles.')
    event_id = current.get((model.POLICY, '')).event_id
    if not isinstance(event_id, str) or not event_id.startswith('$'):
        raise APIError(503, 'The current role revision could not be checked.')
    result = copy.deepcopy(policy); result['io.tavern.previous_event'] = event_id
    return result


async def apply_roles(service, invitation, session, requested, authorize=None):
    # Serialize companion suspension/revocation with the final grant. Native
    # Matrix authorization still applies to the short-lived issuer token.
    async with service.user_locks.setdefault(invitation['creator'], asyncio.Lock()):
        if authorize: authorize()
        await _apply_roles(service, invitation, session, requested, authorize)


async def _apply_roles(service, invitation, session, requested, authorize=None):
    policy = await checked_roles(service, invitation['room_id'], invitation['creator'], requested, session['user_id'])
    if authorize: authorize()
    if policy is None: return
    model = policy_model(service); proposed = copy.deepcopy(policy)
    assigned = proposed['members'].get(session['user_id'], [])
    proposed['members'][session['user_id']] = list(dict.fromkeys([*assigned, *requested]))
    if proposed == policy: return
    if not model.valid_policy(proposed) or not model.may_edit_policy(policy, proposed, invitation['creator']):
        raise APIError(403, 'The default roles cannot be assigned under the current hierarchy.')
    temporary = await service.matrix('POST', '/_synapse/admin/v1/users/' + quote(invitation['creator'], safe='') + '/login', {'valid_until_ms': time.time_ns() // 1_000_000 + 60000}, await service.service_token())
    try:
        if authorize: authorize()
        # Re-read immediately before writing, merging only this recipient's roles.
        latest = await checked_roles(service, invitation['room_id'], invitation['creator'], requested, session['user_id'])
        if authorize: authorize()
        proposed = copy.deepcopy(latest); proposed['members'][session['user_id']] = list(dict.fromkeys([*latest['members'].get(session['user_id'], []), *requested]))
        if not model.valid_policy(proposed) or not model.may_edit_policy(latest, proposed, invitation['creator']):
            raise APIError(403, 'Server roles changed. Ask the server owner to review this invitation.')
        await service.matrix('PUT', '/_matrix/client/v3/rooms/' + quote(invitation['room_id'], safe='') + '/state/' + model.POLICY + '/', proposed, temporary['access_token'])
        service.audit(invitation['creator'], 'invitation_roles_assigned', session['user_id'], invitation['id'])
    finally:
        try: await service.matrix('POST', '/_matrix/client/v3/logout', {}, temporary['access_token'], expected=False)
        except Exception: service.audit('system', 'temporary_invite_role_token_logout_failed', invitation['room_id'])
