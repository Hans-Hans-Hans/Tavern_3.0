"""Current authorization for generic, durable contact-request push notices.

Contact requests are account-service records. They are never represented as
Matrix events, and their identities never enter a provider/browser payload.
"""
import asyncio
import re
import time
from urllib.parse import quote

try:
    from .server import APIError
    from .push_policy import PREFERENCES, scope
except ImportError:
    from server import APIError
    from push_policy import PREFERENCES, scope

REQUEST_ID = re.compile(r'[A-Za-z0-9_-]{24}')
USER_ID = re.compile(r'@[^\s:]{1,128}:[^\s]{1,255}')


def current_request(manager, subscription, job):
    """Synchronous guard, also called immediately before transport writes."""
    session = manager.live(subscription)
    identity = job['social_request_id']
    if job['kind'] != 'social_request' or not isinstance(identity, str) or not REQUEST_ID.fullmatch(identity):
        return None
    active = manager.db.execute("SELECT 1 FROM push_subscriptions WHERE id=? AND generation=? AND state='active'", (subscription['id'], subscription['generation'])).fetchone()
    if not active or manager.maintenance() or job['expires'] <= time.time():
        return None
    row = manager.db.execute('SELECT * FROM social_requests WHERE id=?', (identity,)).fetchone()
    if not row or row['status'] != 'pending' or row['target'] != session['user_id'] or row['created'] != job['created']:
        return None
    sender, target = row['sender'], row['target']
    if not all(isinstance(user, str) and USER_ID.fullmatch(user) for user in (sender, target)) or sender == target or sender.split(':', 1)[1] != target.split(':', 1)[1]:
        return None
    accounts = []
    for user in (sender, target):
        account = manager.service.store.account(user)
        if not account or account.get('access_blocked') or account.get('password_change_required') or manager.service.deactivations.unavailable(user):
            return None
        accounts.append((account.get('credential_epoch', 0), account.get('access_blocked', 0), account.get('password_change_required', 0)))
    if manager.db.execute('SELECT 1 FROM social_blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)', (sender, target, target, sender)).fetchone():
        return None
    preference = manager.db.execute('SELECT requests FROM social_preferences WHERE user_id=?', (target,)).fetchone()
    privacy = preference[0] if preference else 'everyone'
    if privacy not in ('everyone', 'shared_server'):
        return None
    return dict(row), privacy, tuple(accounts)


def preferences_allow(value):
    if not isinstance(value, dict) or not isinstance(value.get('global', {}), dict):
        return False
    global_value = value.get('global', {})
    if 'friendRequests' in global_value and type(global_value['friendRequests']) is not bool:
        return False
    if 'mode' in global_value and global_value['mode'] not in ('inherit', 'all', 'mentions', 'nothing'):
        return False
    if 'mutedUntil' in global_value and (type(global_value['mutedUntil']) is not int or not -1 <= global_value['mutedUntil'] <= 9007199254740991):
        return False
    setting = scope(global_value)
    # Contact requests are directly addressed activity, so mentions mode still
    # permits them. A room or server notification override does not grant consent.
    return (global_value.get('friendRequests') is not False and setting['mode'] != 'nothing'
            and setting['mutedUntil'] != -1 and setting['mutedUntil'] <= time.time() * 1000)


async def eligible(manager, subscription, job):
    initial = current_request(manager, subscription, job)
    if initial is None:
        return False
    request, privacy, _ = initial
    sender, target = request['sender'], request['target']
    session = manager.live(subscription)
    token = manager.service.store.open(session['token'])

    def current():
        if current_request(manager, subscription, job) != initial:
            raise APIError(403, 'This notification is no longer eligible.', 'PUSH_SUPPRESSED')

    async def read(path, missing=False):
        code, value = await manager.native('GET', path, token=token)
        current()
        if code == 404 and missing:
            return {}
        if code in (401, 403):
            raise APIError(403, 'Current notification access was denied.', 'PUSH_SUPPRESSED')
        if code != 200 or not isinstance(value, dict):
            raise APIError(502, 'Current notification permissions could not be checked.')
        return value

    # Only inspect the recipient's own joined rooms. Never enumerate all rooms
    # with the administrator token or borrow another browser's session token.
    witness = None
    if privacy == 'shared_server':
        rooms = (await read('/_matrix/client/v3/joined_rooms')).get('joined_rooms')
        if not isinstance(rooms, list) or len(rooms) > 200 or not all(isinstance(room, str) and room.startswith('!') and len(room) <= 255 for room in rooms):
            return False
        async def shared(room):
            base = '/_matrix/client/v3/rooms/' + quote(room, safe='') + '/state/'
            creation = await read(base + 'm.room.create', True)
            if creation.get('type') != 'm.space':
                return False
            members = await asyncio.gather(*(read(base + 'm.room.member/' + quote(user, safe=''), True) for user in (sender, target)))
            return all(member.get('membership') == 'join' for member in members)
        for index in range(0, len(rooms), 4):
            batch = rooms[index:index + 4]
            results = await asyncio.gather(*(shared(room) for room in batch))
            witness = next((room for room, allowed in zip(batch, results) if allowed), None)
            if witness:
                break
        if not witness:
            return False

    admin_token = await manager.service.service_token()
    current()
    account_path = '/_matrix/client/v3/user/' + quote(target, safe='') + '/account_data/'
    # Mutable choices and native identity/availability follow the potentially
    # slower shared-Space search. The provider refresh and display ticket repeat
    # all checks; native state and external provider writes cannot be atomic.
    who, prefs, presence, ignored, sender_result, target_result = await asyncio.gather(
        read('/_matrix/client/v3/account/whoami'),
        read(account_path + PREFERENCES, True), read(account_path + 'io.tavern.presence', True),
        read(account_path + 'm.ignored_user_list', True),
        manager.native('GET', '/_synapse/admin/v2/users/' + quote(sender, safe=''), token=admin_token),
        manager.native('GET', '/_synapse/admin/v2/users/' + quote(target, safe=''), token=admin_token))
    current()
    # An account-data/native-account wait must not preserve a stale shared-Space
    # witness. Recheck its type and both memberships, then the synchronous gates.
    if witness is not None and not await shared(witness):
        return False
    current()
    if who.get('user_id') != target or who.get('device_id') != session['device_id']:
        return False
    for user, (code, native) in ((sender, sender_result), (target, target_result)):
        if code >= 500:
            raise APIError(502, 'Current notification account availability could not be checked.')
        if code != 200 or not isinstance(native, dict) or native.get('name') != user or type(native.get('admin')) is not bool:
            return False
        if any(native.get(flag) is not False for flag in ('deactivated', 'locked', 'suspended', 'is_guest')):
            return False
    if manager.service.needs_mfa_enrollment(session, target_result[1]['admin']):
        return False
    ignored_users = ignored.get('ignored_users', {})
    return (presence.get('mode') != 'dnd' and isinstance(ignored_users, dict) and sender not in ignored_users
            and preferences_allow(prefs))
