"""Metadata-only push eligibility; no Matrix event decryption or text storage."""
import asyncio
import time
from urllib.parse import quote

try:
    from .server import APIError
except ImportError:
    from server import APIError

PREFERENCES = 'io.tavern.notification_preferences'
DEFAULTS = 'io.tavern.notification.defaults'


def scope(value):
    if not isinstance(value, dict):
        return {'mode': 'inherit', 'mutedUntil': 0}
    return {'mode': value.get('mode') if value.get('mode') in ('all', 'mentions', 'nothing') else 'inherit',
            'mutedUntil': value.get('mutedUntil') if type(value.get('mutedUntil')) is int else 0}


def preferences_allow(preferences, room, parent=None, defaults=('inherit', 'inherit'), now=None):
    now = time.time() * 1000 if now is None else now
    if not isinstance(preferences, dict):
        return False
    global_value = preferences.get('global', {})
    if not isinstance(global_value, dict):
        return False
    global_scope = scope(global_value)
    mode = 'all' if global_scope['mode'] == 'inherit' else global_scope['mode']
    use_defaults = global_value.get('useServerDefaults', global_scope['mode'] == 'inherit')
    if use_defaults is True:
        for default in defaults:
            if default in ('all', 'mentions', 'nothing'):
                mode = default
    scopes = [global_scope]
    for key, identity in (('servers', parent), ('rooms', room)):
        group = preferences.get(key, {})
        if not isinstance(group, dict) or len(group) > 1000:
            return False
        selected = scope(group.get(identity))
        if selected['mode'] != 'inherit':
            mode = selected['mode']
        scopes.append(selected)
    return mode != 'nothing' and not any(s['mutedUntil'] == -1 or s['mutedUntil'] > now for s in scopes)


async def eligible(manager, subscription, job):
    """Native delivery decides relevance; Tavern applies current privacy gates.

    Encrypted event type/mentions cannot be recovered here. We never reinterpret
    a generic encrypted event as a verified mention or an incoming call.
    """
    session = manager.live(subscription)
    if manager.maintenance():
        return False
    token = manager.service.store.open(session['token'])
    user, room = session['user_id'], job['room_id']
    account_path = '/_matrix/client/v3/user/' + quote(user, safe='') + '/account_data/'
    room_path = '/_matrix/client/v3/rooms/' + quote(room, safe='')
    async def read(path, missing=False):
        code, value = await manager.native('GET', path, token=token)
        manager.live(subscription)
        if code == 404 and missing:
            return {}
        if code != 200 or not isinstance(value, dict):
            raise APIError(502, 'Current notification permissions could not be checked.')
        return value
    event = await read(room_path + '/event/' + quote(job['event_id'], safe=''))
    stamp = event.get('origin_server_ts')
    if event.get('event_id') != job['event_id'] or event.get('room_id', room) != room or type(stamp) is not int or not time.time() * 1000 - 300000 <= stamp <= time.time() * 1000 + 30000:
        return False
    sender = event.get('sender')
    if not isinstance(sender, str) or not sender.startswith('@') or sender == user:
        return False
    admin_token = await manager.service.service_token()
    manager.live(subscription)
    code, state = await manager.native('GET', room_path + '/state', token=token)
    manager.live(subscription)
    if code != 200 or not isinstance(state, list) or len(state) > 2000:
        return False
    current = {(e.get('type'), e.get('state_key')): e.get('content') for e in state if isinstance(e, dict)
               and isinstance(e.get('type'), str) and isinstance(e.get('state_key'), str) and isinstance(e.get('content'), dict)}
    parent, server_default = None, 'inherit'
    candidates = [key for (kind, key), content in current.items() if kind == 'm.space.parent' and content.get('canonical') is True and isinstance(content.get('via'), list) and content['via']]
    if len(candidates) > 4:
        return False
    for identity in candidates:
        if not isinstance(identity, str) or not identity.startswith('!') or len(identity) > 255:
            return False
        base = '/_matrix/client/v3/rooms/' + quote(identity, safe='') + '/state/'
        child = await read(base + 'm.space.child/' + quote(room, safe=''), True)
        if isinstance(child.get('via'), list) and child['via']:
            if parent is not None:
                return False  # Ambiguous server authority must not pick a permissive parent.
            parent = identity
            server_default = (await read(base + DEFAULTS, True)).get('mode', 'inherit')
    channel_default = current.get((DEFAULTS, ''), {}).get('mode', 'inherit')
    # Fetch mutable account choices and membership after potentially slow state
    # and parent lookups. Native state changes are never claimed to be atomic
    # with an external provider send; the display ticket rechecks them again.
    membership, prefs, presence, ignored, native_result = await asyncio.gather(
        read(room_path + '/state/m.room.member/' + quote(user, safe='')),
        read(account_path + PREFERENCES, True), read(account_path + 'io.tavern.presence', True),
        read(account_path + 'm.ignored_user_list', True),
        manager.native('GET', '/_synapse/admin/v2/users/' + quote(user, safe=''), token=admin_token))
    manager.live(subscription)
    code, native = native_result
    if code != 200 or not isinstance(native, dict) or native.get('name') != user or native.get('deactivated') is not False or type(native.get('admin')) is not bool:
        return False
    if any(native.get(flag, False) is not False for flag in ('locked', 'suspended')) or manager.service.needs_mfa_enrollment(session, native['admin']):
        return False
    if membership.get('membership') != 'join' or presence.get('mode') == 'dnd' or manager.maintenance():
        return False
    ignored_users = ignored.get('ignored_users', {})
    global_prefs = prefs.get('global', {})
    if not isinstance(ignored_users, dict) or sender in ignored_users or not isinstance(global_prefs, dict):
        return False
    if event.get('type') == 'm.call.invite' and global_prefs.get('incomingCalls') is False:
        return False
    return preferences_allow(prefs, room, parent, (server_default, channel_default))
