"""Opt-in plaintext profile-extension bounds; never classify encrypted content."""
from collections.abc import Mapping
import json
import re
from urllib.parse import urlsplit

PROFILE_POLICY = 'io.tavern.server.profile_policy'
PROFILE = 'io.tavern.profile'
PRIVATE = 'io.tavern.private_thread'
BIO_LIMITS = frozenset({0, 160, 500, 1000})
STATUS_LIMITS = frozenset({0, 40, 80, 160})
MAX_BYTES = 32768
TEXT_LIMITS = {'name': 60, 'bio': 1000, 'pronouns': 50, 'timezone': 80, 'language': 30,
               'status': 160, 'statusEmoji': 16}


class ProfilePolicyDenied(Exception):
    pass


def value(state, kind, key=''):
    event = state.get((kind, key))
    return event.content if event else {}


def snapshot(data):
    # Synapse1.160 event.content is a Rust-backed Mapping, not a Python dict.
    if isinstance(data, Mapping):
        return {key: snapshot(item) for key, item in data.items()}
    if isinstance(data, (list, tuple)):
        return [snapshot(item) for item in data]
    if data is None or type(data) in (str, bool, int, float):
        return data
    raise ValueError('Invalid JSON value')


def valid_settings(data):
    return (isinstance(data, Mapping)
            and set(data) == {'version', 'enabled', 'allowLinks', 'allowCustomFields', 'maxBioLength', 'maxStatusLength', 'io.tavern.previous_event'}
            and type(data.get('version')) is int and data['version'] == 1
            and all(type(data.get(key)) is bool for key in ('enabled', 'allowLinks', 'allowCustomFields'))
            and type(data.get('maxBioLength')) is int and data['maxBioLength'] in BIO_LIMITS
            and type(data.get('maxStatusLength')) is int and data['maxStatusLength'] in STATUS_LIMITS
            and (data['io.tavern.previous_event'] is None or isinstance(data['io.tavern.previous_event'], str)
                 and bool(re.fullmatch(r'\$[^\s\x00-\x1f\x7f]{1,1023}', data['io.tavern.previous_event']))))


def text(value, maximum, multiline=True):
    return (isinstance(value, str) and len(value.encode('utf-16-le', errors='surrogatepass')) // 2 <= maximum
            and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]' if multiline else r'[\x00-\x20\x7f\ud800-\udfff]', value))


def safe_url(value, mxc=False):
    if not text(value, 1024 if mxc else 1000, multiline=False) or not value or '\\' in value:
        return False
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in ({'mxc'} if mxc else {'http', 'https'}) or not parsed.hostname
                or parsed.username is not None or parsed.password is not None):
            return False
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            return False
        return not mxc or (not parsed.query and not parsed.fragment and bool(re.fullmatch(r'/[^/]+', parsed.path)))
    except (ValueError, UnicodeError):
        return False


def profile_error(profile, room_id, is_space):
    if (not isinstance(profile, Mapping) or type(profile.get('version')) is not int or profile['version'] != 1
            or set(profile) - ({'version', 'avatar', 'banner', 'accent', 'statusUntil', 'links', 'fields', 'serverOverride'} | set(TEXT_LIMITS))):
        return 'Use a supported version1 profile extension without extra fields.'
    for key, maximum in TEXT_LIMITS.items():
        if not text(profile.get(key, ''), maximum):
            return 'The profile ' + key + ' contains unsupported text or exceeds its length limit.'
    for key in ('avatar', 'banner'):
        item = profile.get(key, '')
        if item != '' and not safe_url(item, mxc=True):
            return 'Profile artwork must use a bounded Matrix media URI.'
    accent = profile.get('accent', '')
    if not isinstance(accent, str) or accent and not re.fullmatch(r'#[0-9A-Fa-f]{6}', accent):
        return 'Choose a valid profile accent color.'
    until = profile.get('statusUntil', 0)
    if type(until) is not int or not 0 <= until <= 9007199254740991:
        return 'Choose a valid profile status expiration.'
    override = profile.get('serverOverride', '')
    if not isinstance(override, str) or override and (not is_space or override != room_id):
        return 'A server profile override must belong to this server.'
    links, fields = profile.get('links', []), profile.get('fields', [])
    if not isinstance(links, (list, tuple)) or len(links) > 5 or not isinstance(fields, (list, tuple)) or len(fields) > 8:
        return 'Keep at most five profile links and eight custom fields.'
    for link in links:
        if not isinstance(link, Mapping) or set(link) != {'label', 'url'} or not text(link['label'], 60) or not safe_url(link['url']):
            return 'Profile links require bounded HTTP or HTTPS URLs without credentials.'
    for field in fields:
        if (not isinstance(field, Mapping) or set(field) != {'label', 'value'}
                or not text(field['label'], 60) or not field['label'].strip()
                or not text(field['value'], 300) or not field['value'].strip()):
            return 'Custom profile fields require bounded, nonempty labels and values.'
    if len(json.dumps(snapshot(profile), ensure_ascii=False, separators=(',', ':')).encode()) > MAX_BYTES:
        return 'The profile extension exceeds 32 KiB.'
    return None


class ProfileMetadataPolicy:
    def __init__(self, api, model):
        self.api, self.model = api, model

    @staticmethod
    def owner(state, actor):
        create = state.get(('m.room.create', ''))
        return bool(create and create.sender == actor and create.content.get('type') == 'm.space')

    async def scopes(self, room_id, state):
        creation = value(state, 'm.room.create')
        if creation.get('type') == PRIVATE:
            try:
                from private_thread import binding
            except ImportError:
                from synapse_modules.private_thread import binding
            data = binding(creation)
            if not data:
                raise ValueError('Invalid private source')
            room_id = data['source_room_id']
            state = await self.api.get_room_state(room_id)
            source = value(state, 'm.room.create')
            if source.get('m.federate') is not False or source.get('type') in (PRIVATE, 'm.space'):
                raise ValueError('Invalid private source')
        found = [(room_id, state)] if (PROFILE_POLICY, '') in state else []
        parents = {key for (kind, key), item in state.items() if kind == 'm.space.parent' and item.content.get('canonical') is True and item.content.get('via')}
        if len(parents) > 32:
            raise ValueError('Too many server scopes')
        for parent_id in sorted(parents):
            parent = await self.api.get_room_state(parent_id)
            if (PROFILE_POLICY, '') in parent and value(parent, 'm.space.child', room_id).get('via'):
                found.append((parent_id, parent))
        return found

    def may_configure(self, event, state):
        creation, previous = value(state, 'm.room.create'), state.get((PROFILE_POLICY, ''))
        if (getattr(event, 'state_key', None) != '' or not valid_settings(event.content)
                or creation.get('type') != 'm.space' or creation.get('m.federate') is not False
                or event.content['io.tavern.previous_event'] != (previous.event_id if previous else None)
                or value(state, 'm.room.member', event.sender).get('membership') != 'join'):
            return False
        powers = value(state, 'm.room.power_levels')
        if not isinstance(powers.get('events', {}), Mapping):
            return False
        threshold = powers.get('events', {}).get(PROFILE_POLICY, powers.get('state_default', 50))
        power = self.model.native_member_power(state, event.sender)
        if type(threshold) is not int or power is None or power < threshold:
            return False
        policy = value(state, self.model.POLICY)
        if (self.model.POLICY, '') in state:
            return self.model.valid_policy(policy) and 'manage_server' in self.model.permissions(policy, event.sender)
        return self.owner(state, event.sender)

    @staticmethod
    def fingerprint(scopes):
        return {identity: (current[(PROFILE_POLICY, '')].event_id, snapshot(value(current, PROFILE_POLICY)),
                           getattr(current.get(('m.room.create', '')), 'sender', None), snapshot(value(current, 'm.room.create')))
                for identity, current in scopes}

    def validate_publication(self, event, state, active):
        if event.sender != event.state_key:
            raise ProfilePolicyDenied('Only the account owner can publish its extended membership profile.')
        profile = event.content[PROFILE]
        error = profile_error(profile, event.room_id, value(state, 'm.room.create').get('type') == 'm.space')
        if error:
            raise ProfilePolicyDenied(error)
        if profile.get('links') and any(not policy['allowLinks'] for policy in active):
            raise ProfilePolicyDenied('This server does not allow profile links. Remove the link list before publishing here.')
        if profile.get('fields') and any(not policy['allowCustomFields'] for policy in active):
            raise ProfilePolicyDenied('This server does not allow custom profile fields. Remove them before publishing here.')
        for field, setting in (('bio', 'maxBioLength'), ('status', 'maxStatusLength')):
            maximum = min(policy[setting] for policy in active)
            if not text(profile.get(field, ''), maximum):
                raise ProfilePolicyDenied('This server limits profile ' + field + ' to ' + str(maximum) + ' characters.')
            if field == 'status' and maximum == 0 and profile.get('statusEmoji'):
                raise ProfilePolicyDenied('This server disables profile status. Remove the status emoji before publishing here.')

    async def publication(self, event, state):
        scopes = await self.scopes(event.room_id, state)
        before = self.fingerprint(scopes)
        active = []
        for _, current in scopes:
            config = value(current, PROFILE_POLICY)
            if not valid_settings(config):
                raise ProfilePolicyDenied('The server profile policy needs repair. Remove the extended profile or contact its owner.')
            if not config['enabled']:
                continue
            creation = value(current, 'm.room.create')
            if creation.get('type') != 'm.space' or creation.get('m.federate') is not False:
                raise ProfilePolicyDenied('The server profile policy has an invalid scope.')
            active.append(config)
        if active:
            self.validate_publication(event, state, active)
        # Refresh even if the observed state was off/missing: an owner can
        # enable a requirement or attach a new canonical parent during a read.
        current = await self.api.get_room_state(event.room_id)
        if value(state, 'm.room.create').get('type') == PRIVATE and snapshot(value(current, 'm.room.create')) != snapshot(value(state, 'm.room.create')):
            raise ProfilePolicyDenied('The private discussion source changed. Reopen the discussion.')
        if before != self.fingerprint(await self.scopes(event.room_id, current)):
            raise ProfilePolicyDenied('The server profile requirements changed. Reload the profile before publishing.')
        return True

    async def check(self, event, state):
        kind, key = event.type, getattr(event, 'state_key', None)
        if kind == 'm.room.member' and event.content.get('membership') == 'leave':
            return True  # Neither self-leave nor moderation becomes a profile publication.
        try:
            if kind == PROFILE_POLICY:
                if not self.may_configure(event, state):
                    return False
                return self.may_configure(event, await self.api.get_room_state(event.room_id))
            if kind == 'm.room.redaction':
                target = getattr(event, 'redacts', None) or event.content.get('redacts')
                original = await self.api._store.get_event(target, allow_none=True) if target else None
                if original and original.type == PROFILE_POLICY:
                    return False
                if original and original.type in ('m.space.parent', 'm.space.child'):
                    parent = state if original.type == 'm.space.child' else await self.api.get_room_state(original.state_key)
                    if (PROFILE_POLICY, '') in parent:
                        return False
            if kind in ('m.space.parent', 'm.space.child') and value(state, kind, key).get('via'):
                previous = value(state, kind, key)
                removing = not event.content.get('via') or kind == 'm.space.parent' and previous.get('canonical') is True and event.content.get('canonical') is not True
                if removing:
                    parent = state if kind == 'm.space.child' else await self.api.get_room_state(key)
                    if (PROFILE_POLICY, '') in parent and not self.owner(parent, event.sender):
                        return False
            if kind == 'm.room.member' and event.content.get('membership') == 'join' and PROFILE in event.content:
                return await self.publication(event, state)
            return True
        except ProfilePolicyDenied:
            raise
        except Exception:
            raise ProfilePolicyDenied('Server profile requirements are temporarily unavailable. Retry or remove the extended profile.') from None
