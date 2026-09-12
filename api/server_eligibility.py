"""Private eligibility bridge and shared conference admission check."""
import hashlib
import hmac
import os
from pathlib import Path
import re
import time
from types import SimpleNamespace
from urllib.parse import quote

from aiohttp import web

try:
    from .server import APIError
    from .room_authority import policy_model, room_id, state
except ImportError:
    from server import APIError
    from room_authority import policy_model, room_id, state


def account_status(service, user):
    # Missing companion records are unverified, but do not disqualify a native
    # legacy account from an age-only rule. This read never creates an account.
    account = service.store.account(user)
    return {'available': not bool(account.get('access_blocked')) and not service.deactivations.unavailable(user),
            'emailVerified': bool(account.get('verified') == 1 and account.get('email'))}


async def internal_status(request):
    user = request.query.get('user', '')
    timestamp = request.headers.get('X-Tavern-Privacy-Timestamp', '')
    supplied = request.headers.get('X-Tavern-Privacy-Signature', '')
    valid = (set(request.query) == {'user'} and len(request.query.getall('user')) == 1
             and re.fullmatch(r'[0-9a-f]{64}', supplied)
             and re.fullmatch(r'@[^\s:\x00-\x1f\x7f]{1,254}:[^\s\x00-\x1f\x7f]{1,254}', user)
             and re.fullmatch(r'[0-9]{1,12}', timestamp) and abs(time.time() - int(timestamp)) <= 30)
    if valid:
        try:
            key = bytes.fromhex(Path(os.environ.get('PRIVACY_KEY_FILE', '/synapse/tavern-privacy.key')).read_text().strip())
            payload = '\n'.join(('v1', 'server-eligibility', timestamp, user))
            expected = hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()
            valid = len(key) == 32 and hmac.compare_digest(expected, supplied)
        except (OSError, ValueError):
            valid = False
    if not valid:
        raise APIError(403, 'This internal request is not authorized.', 'FORBIDDEN')
    return web.json_response(account_status(request.app['service'], user), headers={'Cache-Control': 'no-store'})


async def require_room_eligibility(service, session, identity, current=None):
    """Additional restriction only; callers must first prove native room access."""
    identity = room_id(identity)
    model = policy_model(service)

    async def read_state(target):
        return await state(service, room_id(target))

    async def native_user(user):
        result = await service.matrix('GET', '/_synapse/admin/v2/users/' + quote(user, safe=''), token=await service.service_token())
        if not isinstance(result, dict) or result.get('name') != user:
            return None
        # Single-user admin lookup, like UserInfo, uses seconds. The paginated
        # users endpoint uses milliseconds and is deliberately not used here.
        return SimpleNamespace(creation_ts=result.get('creation_ts'), is_deactivated=result.get('deactivated'),
                               is_guest=result.get('is_guest'), locked=result.get('locked'), suspended=result.get('suspended'))

    observed_accounts = []

    async def read_account(user):
        result = account_status(service, user)
        observed_accounts.append(result)
        return result

    actor = session['user_id']
    adapter = SimpleNamespace(get_room_state=read_state, get_userinfo_by_id=native_user,
                              is_mine=lambda user: user == actor)
    policy = model.ServerEligibilityPolicy({}, adapter, model)
    policy.account = read_account
    reason = await policy.denial(identity, current if current is not None else await read_state(identity), actor)
    if reason:
        raise APIError(403, reason, 'SERVER_ELIGIBILITY_REQUIRED')
    admission = model.ChannelAdmissionPolicy(adapter, model.valid_policy, model.native_member_power)
    reason = await admission.denial(identity, current if current is not None else await read_state(identity), actor)
    if reason:
        raise APIError(403, reason, 'CHANNEL_ACCESS_DENIED')
    # Native account availability is mandatory for RTC even when this room has
    # no optional age/email policy (or the actor is its exempt creator). Read
    # it after room-policy awaits so native suspension cannot hide behind them.
    if not policy.native_available(await native_user(actor)):
        raise APIError(403, 'This account is not available for conference participation.', 'CALL_ACCESS_DENIED')
    # The final parent read may await native state; local revocation is checked
    # again synchronously so it cannot be hidden behind that network response.
    final_account = account_status(service, actor)
    if not final_account['available'] or observed_accounts and final_account != observed_accounts[-1]:
        raise APIError(403, 'The account verification changed. Check Account settings and try again.', 'SERVER_ELIGIBILITY_REQUIRED')


def register_routes(app):
    app.add_routes([web.get('/api/internal/server-eligibility', internal_status)])
