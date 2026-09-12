"""Native audience decisions for role-managed private channels.

This module is additional to Matrix authorization. It does not grant permission
to invite, write state, publish media, or read a room. Joining still uses the
requesting user's native Matrix session and restricted-room authorization.
"""
from collections.abc import Mapping
from contextvars import ContextVar
import re

POLICY = 'io.tavern.roles'
MARKER = 'channelAdmissionVersion'
AUDIENCES = 'channelAdmissions'
PRIVATE = 'io.tavern.private_thread'
ROOM = re.compile(r'![^\s\x00-\x1f\x7f]{1,1023}\Z')
USER = re.compile(r'@[^\s:\x00-\x1f\x7f]{1,255}:[^\s\x00-\x1f\x7f]{1,255}\Z')
DENIED = 'This private channel is limited to its selected roles and members.'
CHANGED = 'Private channel access changed. Refresh and try again.'
UNAVAILABLE = 'Private channel access could not be verified. Try again shortly.'
revocation_guard = ContextVar('tavern_channel_revocation', default=None)


def content(state, kind, key=''):
    event = state.get((kind, key))
    return event.content if event else {}


def valid_admissions(policy, role_ids):
    """No marker means legacy behavior; a present empty audience is owner-only."""
    if not isinstance(policy, Mapping):
        return False
    if MARKER not in policy:
        return AUDIENCES not in policy
    if type(policy[MARKER]) is not int or policy[MARKER] != 1:
        return False
    audiences = policy.get(AUDIENCES)
    if not isinstance(audiences, Mapping) or len(audiences) > 1000:
        return False
    for room, audience in audiences.items():
        if (not isinstance(room, str) or not ROOM.fullmatch(room)
                or not isinstance(audience, Mapping) or set(audience) != {'roleIds', 'userIds'}):
            return False
        roles, users = audience['roleIds'], audience['userIds']
        if (not isinstance(roles, (list, tuple)) or len(roles) > 100
                or any(not isinstance(role, str) or role not in role_ids for role in roles)
                or len(set(roles)) != len(roles)
                or not isinstance(users, (list, tuple)) or len(users) > 1000
                or any(not isinstance(user, str) or not USER.fullmatch(user) for user in users)
                or len(set(users)) != len(users)):
            return False
    return True


def active_audience(policy, room):
    """Call after full policy validation, including valid_admissions."""
    return policy.get(AUDIENCES, {}).get(room) if policy.get(MARKER) == 1 else None


def audience_allows(policy, room, actor):
    audience = active_audience(policy, room)
    if audience is None:
        return True
    if actor == policy['owner']:
        return True
    assigned = set(policy['members'].get(actor, [])) | {'everyone'}
    return actor in audience['userIds'] or bool(assigned.intersection(audience['roleIds']))


def admission_changed(previous, proposed):
    return (previous.get(MARKER), previous.get(AUDIENCES)) != (proposed.get(MARKER), proposed.get(AUDIENCES))


def restricted_rule(scopes):
    """Native join-rule proposal for the already resolved active server scopes."""
    return {'join_rule': 'restricted', 'allow': [
        {'type': 'm.room_membership', 'room_id': server} for server in sorted(scopes)
    ]}


class ChannelAdmissionPolicy:
    def __init__(self, api, valid_policy, native_power=None):
        self.api, self.valid_policy, self.native_power = api, valid_policy, native_power

    async def scopes(self, room_id, state):
        """Resolve every reciprocal canonical server and a discussion's source."""
        if content(state, 'm.room.create').get('type') == PRIVATE:
            try:
                from private_thread import binding
            except ImportError:
                from synapse_modules.private_thread import binding
            source = binding(content(state, 'm.room.create'))
            if not source:
                raise ValueError('Invalid private discussion source')
            room_id = source['source_room_id']
            state = await self.api.get_room_state(room_id)
            if content(state, 'm.room.create').get('type') in {PRIVATE, 'm.space'}:
                raise ValueError('Invalid private discussion source')
        parents = [key for (kind, key), event in state.items()
                   if kind == 'm.space.parent' and event.content.get('canonical') is True and event.content.get('via')]
        if len(parents) > 32:
            raise ValueError('Too many channel parents')
        scopes = {}
        for server in sorted(parents):
            parent = await self.api.get_room_state(server)
            if not content(parent, 'm.space.child', room_id).get('via'):
                continue
            policy = content(parent, POLICY)
            if MARKER not in policy and AUDIENCES not in policy:
                continue
            if not self.valid_policy(policy) or not valid_admissions(policy, {role['id'] for role in policy.get('roles', [])}):
                raise ValueError('Invalid channel audience policy')
            if active_audience(policy, room_id) is not None:
                scopes[server] = parent
        return room_id, scopes

    def allowed_in_scope(self, state, room, actor):
        creation = state.get(('m.room.create', ''))
        policy = content(state, POLICY)
        return bool(creation and creation.content.get('type') == 'm.space'
                    and creation.content.get('m.federate') is False
                    and creation.sender == policy.get('owner') and self.api.is_mine(actor)
                    and content(state, 'm.room.member', actor).get('membership') == 'join'
                    and audience_allows(policy, room, actor))

    async def denial(self, room, state, actor):
        """Freshly evaluate both member assignments and membership after awaits."""
        try:
            source, scopes = await self.scopes(room, state)
            if not scopes:
                return None
            before = {server: (getattr(parent.get((POLICY, '')), 'event_id', None),
                               getattr(parent.get(('m.room.member', actor)), 'event_id', None),
                               getattr(parent.get(('m.space.child', source)), 'event_id', None))
                      for server, parent in scopes.items()}
            source_member = None
            if source != room:
                source_state = await self.api.get_room_state(source)
                source_member = source_state.get(('m.room.member', actor))
            fresh = await self.api.get_room_state(room) if room else state
            fresh_source, latest = await self.scopes(room, fresh)
            after = {server: (getattr(parent.get((POLICY, '')), 'event_id', None),
                              getattr(parent.get(('m.room.member', actor)), 'event_id', None),
                              getattr(parent.get(('m.space.child', fresh_source)), 'event_id', None))
                     for server, parent in latest.items()}
            if source != fresh_source or before != after:
                return CHANGED
            if source != room:
                source_state = await self.api.get_room_state(source)
                latest_member = source_state.get(('m.room.member', actor))
                if getattr(source_member, 'event_id', None) != getattr(latest_member, 'event_id', None):
                    return CHANGED
                if not latest_member or latest_member.content.get('membership') != 'join':
                    return DENIED
            return None if all(self.allowed_in_scope(parent, source, actor) for parent in latest.values()) else DENIED
        except Exception:
            return UNAVAILABLE

    async def policy_change_allowed(self, event, state):
        previous = content(state, POLICY)
        proposed = event.content
        if not any(key in value for value in (previous, proposed) for key in (MARKER, AUDIENCES)):
            return True
        current = state.get((POLICY, ''))
        if (getattr(event, 'state_key', None) != '' or not self.valid_policy(proposed)
                or not valid_admissions(proposed, {role['id'] for role in proposed.get('roles', [])})
                or MARKER in previous and proposed.get(MARKER) != 1
                or 'io.tavern.previous_event' not in proposed
                or proposed['io.tavern.previous_event'] != (current.event_id if current else None)):
            return False
        if not admission_changed(previous, proposed):
            return True  # Existing native role hierarchy still authorizes assignments.
        create = state.get(('m.room.create', ''))
        if (not create or create.sender != event.sender or proposed.get('owner') != event.sender
                or create.content.get('type') != 'm.space' or create.content.get('m.federate') is not False
                or not self.api.is_mine(event.sender)
                or content(state, 'm.room.member', event.sender).get('membership') != 'join'):
            return False
        before, after = previous.get(AUDIENCES, {}), proposed.get(AUDIENCES, {})
        for room in set(before) | set(after):
            if before.get(room) == after.get(room):
                continue
            channel = await self.api.get_room_state(room)
            creation, parent = content(channel, 'm.room.create'), content(channel, 'm.space.parent', event.room_id)
            rules, powers = content(channel, 'm.room.join_rules'), content(channel, 'm.room.power_levels')
            power = self.native_power(channel, event.sender) if self.native_power else None
            threshold = powers.get('events', {}).get('m.room.join_rules', powers.get('state_default', 50))
            if (creation.get('type') in {'m.space', PRIVATE} or creation.get('m.federate') is not False
                    or content(channel, 'm.room.encryption').get('algorithm') != 'm.megolm.v1.aes-sha2'
                    or parent.get('canonical') is not True or not parent.get('via')
                    or not content(state, 'm.space.child', room).get('via')
                    or content(channel, 'm.room.member', event.sender).get('membership') != 'join'
                    or type(threshold) is not int or power is None or power < threshold):
                return False
            # Enable while closed; disable only after restoring invite-only joins.
            if (room not in before or room not in after) and rules.get('join_rule') != 'invite':
                return False
        fresh = await self.api.get_room_state(event.room_id)
        keys = [(POLICY, ''), ('m.room.create', ''), ('m.room.power_levels', ''), ('m.room.member', event.sender)]
        keys += [('m.space.child', room) for room in set(before) | set(after)]
        return all(getattr(state.get(key), 'event_id', None) == getattr(fresh.get(key), 'event_id', None) for key in keys)

    async def check(self, event, state):
        """Enforce on invited joins too; native restricted-join checks may skip them."""
        try:
            if event.type == POLICY:
                return await self.policy_change_allowed(event, await self.api.get_room_state(event.room_id))
            if event.type == 'm.room.redaction':
                target = getattr(event, 'redacts', None) or event.content.get('redacts')
                original = await self.api._store.get_event(target, allow_none=True) if target else None
                if original and original.type == POLICY:
                    return not any(key in content(state, POLICY) for key in (MARKER, AUDIENCES))
                if original and original.type in {'m.space.parent', 'm.space.child'}:
                    server, channel = ((event.room_id, original.state_key) if original.type == 'm.space.child'
                                       else (original.state_key, event.room_id))
                    parent = state if server == event.room_id else await self.api.get_room_state(server)
                    if active_audience(content(parent, POLICY), channel) is not None:
                        return False
            if event.type in {'m.space.parent', 'm.space.child'}:
                server, channel = ((event.room_id, event.state_key) if event.type == 'm.space.child'
                                   else (event.state_key, event.room_id))
                parent = state if server == event.room_id else await self.api.get_room_state(server)
                if active_audience(content(parent, POLICY), channel) is not None:
                    if not event.content.get('via') or event.type == 'm.space.parent' and event.content.get('canonical') is not True:
                        return False
            if event.type == 'm.room.join_rules':
                _, scopes = await self.scopes(event.room_id, state)
                if scopes and event.content.get('join_rule') != 'invite' and event.content != restricted_rule(scopes):
                    return False
            try:
                from server_account_eligibility import cleanup
            except ImportError:
                from synapse_modules.server_account_eligibility import cleanup
            if cleanup(event, state):
                guard = revocation_guard.get()
                if guard is not None and event.type == 'm.room.member':
                    return (guard == (event.room_id, event.sender)
                            and event.state_key == event.sender
                            and await self.denial(event.room_id, state, event.sender) == DENIED)
                return True
            if event.type == 'm.room.member':
                # Native auth still protects kicks/bans; revocation must not trap a member.
                if event.content.get('membership') not in {'join', 'invite', 'knock'}:
                    return True
                if await self.denial(event.room_id, state, event.state_key):
                    return False
            return await self.denial(event.room_id, state, event.sender) is None
        except Exception:
            return False
