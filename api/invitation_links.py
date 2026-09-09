"""Readable invitation names remain bound to one invitation for their lifetime."""
import re
import time

try:
    from .server import APIError
    from .room_authority import room_authority, content, power
except ImportError:
    from server import APIError
    from room_authority import room_authority, content, power

RESERVED = frozenset({'admin', 'api', 'auth', 'login', 'register', 'settings', 'health', 'assets', 'account', 'invite'})
SLUG = re.compile(r'[a-z0-9][a-z0-9-]{1,46}[a-z0-9]')


def valid_slug(value):
    return isinstance(value, str) and bool(SLUG.fullmatch(value)) and '--' not in value and value not in RESERVED


def custom_slug(value):
    if value is None or value == '':
        return None
    if not valid_slug(value):
        raise APIError(400, 'Choose 3–48 lowercase letters, numbers or single hyphens, with a letter or number at each end. This name may be reserved.', 'INVALID_INVITATION_NAME')
    return value


def schema(store):
    # Intentionally no cascading foreign key: a deleted invitation must never
    # free its published name to point old links at a different invitation.
    store.db.execute('''CREATE TABLE IF NOT EXISTS invitation_link_names(
        slug TEXT PRIMARY KEY,invitation_id TEXT UNIQUE NOT NULL,room_id TEXT NOT NULL,created REAL NOT NULL)''')


def reserve(store, slug, identity, room_id):
    store.db.execute('INSERT INTO invitation_link_names VALUES(?,?,?,?)', (slug, identity, room_id, time.time()))


def lookup(store, handle):
    if not isinstance(handle, str) or not handle.startswith('v:') or not valid_slug(handle[2:]):
        return None
    return store.db.execute('''SELECT invitations.* FROM invitation_link_names AS names
        JOIN invitations ON invitations.id=names.invitation_id AND invitations.room_id=names.room_id
        AND invitations.custom_slug=names.slug WHERE names.slug=?''', (handle[2:],)).fetchone()


async def require_custom_authority(service, session, room_id):
    authority = await room_authority(service, session, room_id)
    current, model, actor = authority.state, authority.model, session['user_id']
    create = content(current, 'm.room.create')
    if create.get('type') != 'm.space' or create.get('m.federate', True) is not False:
        raise APIError(400, 'Custom invitation names are available only for local, non-federated servers.')
    authority.require('manage_server', native='state_default')
    invite_power = content(current, 'm.room.power_levels').get('invite', 0)
    if type(invite_power) is not int or power(current, actor) < invite_power:
        raise APIError(403, 'You need current native invitation permission to publish this name.')
    if (model.POLICY, '') not in current:
        creator = current.get(('m.room.create', ''))
        if not creator or creator.sender != actor:
            raise APIError(403, 'Only the server creator can publish a custom invitation name before server roles are configured.')
    elif any('invite' not in model.permissions(policy, actor, room_id) for _, policy, _ in authority.policies):
        raise APIError(403, 'Your current server role does not permit invitations.')
    if service.store.account(actor).get('access_blocked') or service.deactivations.unavailable(actor):
        raise APIError(403, 'This account cannot publish invitation names.')
