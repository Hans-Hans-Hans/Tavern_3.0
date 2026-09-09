"""Account eligibility for local Spaces; ciphertext and client claims are irrelevant."""
from collections.abc import Mapping
import hashlib
import hmac
from pathlib import Path
import re
import time

ELIGIBILITY = 'io.tavern.server.eligibility'
AGES = frozenset({0, 300, 3600, 86400, 604800})
AGE_LABELS = {300: '5 minutes', 3600: '1 hour', 86400: '1 day', 604800: '7 days'}
PRIVATE = 'io.tavern.private_thread'
CALL_MEMBERS = {'org.matrix.msc3401.call.member', 'org.matrix.msc4143.rtc.member'}


class EligibilityDenied(Exception):
    pass


def value(state, kind, key=''):
    item = state.get((kind, key))
    return item.content if item else {}


def valid_settings(data):
    revision = data.get('io.tavern.previous_event') if isinstance(data, Mapping) else None
    return (isinstance(data, Mapping)
            and set(data) == {'version', 'requireVerifiedEmail', 'minimumAccountAgeSeconds', 'io.tavern.previous_event'}
            and type(data.get('version')) is int and data['version'] == 1
            and type(data.get('requireVerifiedEmail')) is bool
            and type(data.get('minimumAccountAgeSeconds')) is int and data['minimumAccountAgeSeconds'] in AGES
            and (revision is None or isinstance(revision, str) and bool(re.fullmatch(r'\$[^\s\x00-\x1f\x7f]{1,1023}', revision))))


def enabled(data):
    return not valid_settings(data) or data['requireVerifiedEmail'] or data['minimumAccountAgeSeconds'] > 0


def cleanup(event, state):
    key = getattr(event, 'state_key', None)
    if event.type == 'm.room.member':
        return key == event.sender and event.content.get('membership') == 'leave'
    if value(state, 'm.room.create').get('type') == PRIVATE:
        return False  # Private discussions have no call protocol to tear down.
    if event.type in CALL_MEMBERS:
        previous = state.get((event.type, key))
        return bool(previous and previous.sender == event.sender and (not event.content or event.content == {'memberships': []}))
    return event.type in {'m.call.hangup', 'm.call.reject'}


def signature(key, timestamp, user):
    return hmac.new(key, '\n'.join(('v1', 'server-eligibility', timestamp, user)).encode(), hashlib.sha256).hexdigest()


def json_snapshot(data):
    # Native event.content is a Rust-backed Mapping. Snapshot only its JSON
    # values, without relying on extension-object pickle/deepcopy support.
    if isinstance(data, Mapping):
        if any(not isinstance(key, str) for key in data):
            raise ValueError('Invalid JSON object')
        return {key: json_snapshot(item) for key, item in data.items()}
    if isinstance(data, list):
        return [json_snapshot(item) for item in data]
    if data is None or type(data) in (str, bool, int, float):
        return data
    raise ValueError('Invalid JSON value')


def fingerprint(scopes, room_id):
    return {identity: (getattr(current.get((ELIGIBILITY, '')), 'event_id', None),
                       getattr(current.get(('m.room.create', '')), 'sender', None),
                       json_snapshot(value(current, ELIGIBILITY)), json_snapshot(value(current, 'm.room.create')),
                       json_snapshot(value(current, 'm.space.child', room_id))) for identity, current in scopes}


class ServerEligibilityPolicy:
    def __init__(self, config, api, model):
        self.api, self.model = api, model
        self.url = config.get('privacy_api_url', '')
        self.key_file = Path(config.get('privacy_key_file', '/data/tavern-privacy.key'))

    @staticmethod
    def native_available(user):
        # These are the exact boolean fields on pinned Synapse UserInfo. In
        # particular, suspension does not invalidate account/whoami tokens.
        return user is not None and all(getattr(user, field, None) is False
            for field in ('is_deactivated', 'is_guest', 'locked', 'suspended'))

    async def account(self, user):
        """Private, authenticated current database read; no email address leaves the API."""
        try:
            key = bytes.fromhex(self.key_file.read_text().strip())
            if len(key) != 32 or not self.url:
                return None
            timestamp = str(int(time.time()))
            client = self.api.http_client
            request = client.get_json(self.url + '/api/internal/server-eligibility', args={'user': user}, headers={
                b'X-Tavern-Privacy-Timestamp': [timestamp.encode()],
                b'X-Tavern-Privacy-Signature': [signature(key, timestamp, user).encode()]})
            if hasattr(client, 'reactor'):
                from twisted.internet.defer import ensureDeferred
                request = ensureDeferred(request).addTimeout(5, client.reactor)
            result = await request
            return result if isinstance(result, Mapping) and type(result.get('available')) is bool and type(result.get('emailVerified')) is bool else None
        except Exception:
            return None

    async def scopes(self, room_id, state, event=None):
        """All direct reciprocal canonical parents; private rooms inherit their immutable source."""
        create = value(state, 'm.room.create')
        if create.get('type') == PRIVATE:
            try:
                from private_thread import binding
            except ImportError:
                from synapse_modules.private_thread import binding
            data = binding(create)
            if not data:
                raise ValueError('Invalid private source')
            room_id = data['source_room_id']
            state = await self.api.get_room_state(room_id)
            if value(state, 'm.room.create').get('type') in {PRIVATE, 'm.space'}:
                raise ValueError('Invalid private source')
        found = [(room_id, state)] if (ELIGIBILITY, '') in state else []
        parents = {key for (kind, key), item in state.items() if kind == 'm.space.parent' and item.content.get('canonical') is True and item.content.get('via')}
        if event and event.type == 'm.space.parent' and event.content.get('canonical') is True and event.content.get('via'):
            parents.add(event.state_key)
        if len(parents) > 32:
            raise ValueError('Too many parent scopes')
        for parent_id in sorted(parents):
            parent = await self.api.get_room_state(parent_id)
            if (ELIGIBILITY, '') in parent and value(parent, 'm.space.child', room_id).get('via'):
                found.append((parent_id, parent))
        return found

    def owner(self, state, actor):
        create = state.get(('m.room.create', ''))
        return bool(create and create.sender == actor and value(state, 'm.room.create').get('type') == 'm.space')

    async def eligible(self, room_id, state, actor, event=None):
        return await self.denial(room_id, state, actor, event) is None

    async def denial(self, room_id, state, actor, event=None):
        try:
            scopes = await self.scopes(room_id, state, event)
            before = fingerprint(scopes, room_id)
            required = [(identity, current) for identity, current in scopes if enabled(value(current, ELIGIBILITY)) and not self.owner(current, actor)]
            if not required:
                return None
            if not self.api.is_mine(actor):
                return 'This server requires a local account.'
            for _, current in required:
                creation, config = value(current, 'm.room.create'), value(current, ELIGIBILITY)
                if creation.get('type') != 'm.space' or creation.get('m.federate') is not False or not valid_settings(config):
                    return 'This server account policy needs repair by its owner.'
            native = await self.api.get_userinfo_by_id(actor)
            if not self.native_available(native):
                return 'This account is not available for server participation.'
            minimum = max(value(current, ELIGIBILITY)['minimumAccountAgeSeconds'] for _, current in required)
            created = getattr(native, 'creation_ts', None)
            if minimum and (type(created) is not int or created <= 0 or created > time.time() - minimum):
                return 'This server requires an account at least ' + AGE_LABELS[minimum] + ' old. Try again after that time.'
            account = await self.account(actor)
            if not account:
                return 'Account verification is temporarily unavailable. Try again shortly.'
            if account['available'] is not True:
                return 'This account is restricted. Contact your administrator.'
            if any(value(current, ELIGIBILITY)['requireVerifiedEmail'] for _, current in required) and account['emailVerified'] is not True:
                return 'Verify your email address in Account settings before joining or participating in this server.'
            fresh_native = await self.api.get_userinfo_by_id(actor)
            if not self.native_available(fresh_native):
                return 'This account is not available for server participation.'
            if minimum and getattr(fresh_native, 'creation_ts', None) != created:
                return 'The account details changed. Try again.'
            # Refresh the room too: its own policy and canonical parent set can
            # change while the account lookup waits. Keep the event's proposed
            # parent overlay, which is not persisted yet. An empty room ID is
            # only the private-create preflight; its immutable proposed binding
            # is retained while scopes() rereads the existing source channel.
            fresh_state = await self.api.get_room_state(room_id) if room_id else state
            if value(state, 'm.room.create').get('type') == PRIVATE and value(fresh_state, 'm.room.create') != value(state, 'm.room.create'):
                return 'The private discussion source changed. Reopen the discussion.'
            fresh = await self.scopes(room_id, fresh_state, event)
            after = fingerprint(fresh, room_id)
            return None if before == after else 'The server account requirements changed. Try again.'
        except Exception:
            return 'Account verification is temporarily unavailable. Try again shortly.'

    def may_configure(self, event, state):
        creation, current = value(state, 'm.room.create'), state.get((ELIGIBILITY, ''))
        if (getattr(event, 'state_key', None) != '' or not valid_settings(event.content)
                or creation.get('type') != 'm.space' or creation.get('m.federate') is not False
                or event.content['io.tavern.previous_event'] != (current.event_id if current else None)
                or value(state, 'm.room.member', event.sender).get('membership') != 'join'):
            return False
        powers = value(state, 'm.room.power_levels')
        if not isinstance(powers.get('events', {}), Mapping):
            return False
        threshold = powers.get('events', {}).get(ELIGIBILITY, powers.get('state_default', 50))
        power = self.model.native_member_power(state, event.sender)
        if type(threshold) is not int or power is None or power < threshold:
            return False
        policy = value(state, self.model.POLICY)
        if (self.model.POLICY, '') in state:
            return self.model.valid_policy(policy) and 'manage_server' in self.model.permissions(policy, event.sender)
        return self.owner(state, event.sender)

    async def check(self, event, state):
        if event.type == 'm.room.redaction':
            target = getattr(event, 'redacts', None) or event.content.get('redacts')
            original = await self.api._store.get_event(target, allow_none=True) if target else None
            if original and original.type == ELIGIBILITY:
                return False
            if original and original.type in {'m.space.parent', 'm.space.child'}:
                parent = state if original.type == 'm.space.child' else await self.api.get_room_state(original.state_key)
                if (ELIGIBILITY, '') in parent:
                    return False
        if event.type == ELIGIBILITY and not self.may_configure(event, state):
            return False
        if cleanup(event, state):
            return True
        reason = await self.denial(event.room_id, state, event.sender, event)
        if reason:
            raise EligibilityDenied(reason)
        if event.type == ELIGIBILITY:
            try:
                current = await self.api.get_room_state(event.room_id)
            except Exception:
                raise EligibilityDenied('Server permissions are temporarily unavailable. Try again shortly.') from None
            if not self.may_configure(event, current):
                raise EligibilityDenied('The settings revision or your server permissions changed. Reload settings before saving.')
        if event.type == 'm.room.member' and event.content.get('membership') in {'join', 'invite', 'knock'} and event.state_key != event.sender:
            reason = await self.denial(event.room_id, state, event.state_key, event)
            if reason:
                # Never disclose another account's verification status to an inviter.
                raise EligibilityDenied('The invited account does not currently meet this server\'s account requirements.')
            return True
        # A relationship cannot be removed to evade an active roleless server policy.
        if event.type in {'m.space.parent', 'm.space.child'}:
            previous = value(state, event.type, event.state_key)
            if previous.get('via') and (not event.content.get('via') or event.type == 'm.space.parent' and previous.get('canonical') is True and event.content.get('canonical') is not True):
                parent = state if event.type == 'm.space.child' else await self.api.get_room_state(event.state_key)
                if (ELIGIBILITY, '') in parent and enabled(value(parent, ELIGIBILITY)) and not self.owner(parent, event.sender):
                    return False
        return True
