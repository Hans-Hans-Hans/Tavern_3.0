"""Verify an existing account email without permitting staff to replace it."""
import secrets
import time
from urllib.parse import quote

from aiohttp import web

try:
    from .server import APIError, body_json
    from .security import email_address
except ImportError:
    from server import APIError, body_json
    from security import email_address

KIND = 'associated-email'


def eligible(account, native=None):
    if not account.get('email') or account.get('verified'):
        raise APIError(409, 'This account does not have an unverified email address.')
    if account.get('access_blocked') or native and any(native.get(flag) for flag in ('deactivated', 'locked', 'suspended')):
        raise APIError(403, 'Enable this account before sending or completing email verification.')
    return email_address(account['email'])


async def resend(service, actor, target, native):
    """Caller holds the target user lock and has reauthorized the staff action."""
    account = service.store.account(target)
    email = eligible(account, native)
    service.store.rate('staff-verification:' + actor, 10, 3600)
    service.store.rate('associated-email:' + target, 3, 300)
    service.store.rate('staff-verification:instance', 100, 3600)
    code = str(secrets.randbelow(1000000)).zfill(6)
    service.store.db.execute('DELETE FROM challenges WHERE kind=? AND user_id=?', (KIND, target))
    challenge = service.store.challenge(KIND, {'email': email, 'epoch': account.get('credential_epoch', 0)}, target, code, duration=600)
    try:
        await service.send_email(email, 'Verify your account email', 'An administrator requested verification of the email already associated with ' + target + '.\n\nYour verification code is ' + code + '. It expires in 10 minutes.\n\nSign in to your own Tavern account, open Settings > Account & security, and choose Enter administrator-sent email code. This code cannot change your email address. Do not share it with anyone, including an administrator.')
    except Exception:
        service.store.consume(challenge)
        raise


def pending(service, target):
    row = service.store.db.execute('SELECT id FROM challenges WHERE kind=? AND user_id=? AND expires>? ORDER BY expires DESC LIMIT 1', (KIND, target, time.time())).fetchone()
    if not row:
        raise APIError(409, 'There is no current administrator-sent code. Ask for a new code or use Change or verify email.')
    challenge = service.store.read_challenge(row['id'], KIND, target)
    account = service.store.account(target)
    email = eligible(account)
    if challenge['payload'].get('email') != email or challenge['payload'].get('epoch') != account.get('credential_epoch', 0):
        service.store.consume(challenge['id'])
        raise APIError(409, 'Your account changed after this code was sent. Request a new verification code.')
    return challenge


async def complete(request):
    service = request.app['service']; session = service.require_session(request)
    data = await body_json(request)
    # /api/account/ mutations already hold this user's lock in the boundary.
    service.store.rate('associated-email-complete:' + session['user_id'], 10, 300)
    challenge = pending(service, session['user_id'])
    native = await service.matrix('GET', '/_synapse/admin/v2/users/' + quote(session['user_id'], safe=''), token=await service.service_token())
    service.require_session(request)
    eligible(service.store.account(session['user_id']), native)
    service.store.verify_code(challenge, data.get('code'))
    service.store.consume(challenge['id'])
    result = service.store.db.execute('UPDATE accounts SET verified=1 WHERE user_id=? AND email=? AND verified=0 AND credential_epoch=? AND access_blocked=\'\'',
                                      (session['user_id'], challenge['payload']['email'], challenge['payload']['epoch']))
    if result.rowcount != 1:
        raise APIError(409, 'Your account changed. Request a new verification code.')
    service.audit(session['user_id'], 'associated_email_verified', session['user_id'])
    return web.json_response({'ok': True})


def register_routes(app):
    app.add_routes([web.post('/api/account/email/pending/complete', complete)])
