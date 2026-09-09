"""Private discussions use native encrypted room membership, never hidden threads.

The immutable creation marker is private-room state. There is no parent-room index
or privileged membership service. Source policy gates writes/admission, not reads.
"""
from collections.abc import Mapping
from types import SimpleNamespace
import re
import time

try:
    from channel_policy import value, timeout_active, valid_channel
    from temporary_ban import active as banned
except ImportError:
    from synapse_modules.channel_policy import value, timeout_active, valid_channel
    from synapse_modules.temporary_ban import active as banned

PRIVATE = 'io.tavern.private_thread'
SETTINGS = PRIVATE + '.settings'
INTERVALS = {0, 3600, 86400, 259200, 604800}
PROTECTED = {'m.room.create', 'm.room.encryption', 'm.room.history_visibility',
             'm.room.join_rules', 'm.room.guest_access', 'm.room.power_levels',
             'm.room.name', 'm.room.pinned_events', SETTINGS}


def identifier(value, prefix):
    return isinstance(value, str) and 2 <= len(value) <= 1024 and value.startswith(prefix) and not re.search(r'[\s\x00-\x1f\x7f]', value)


def binding(content):
    if not isinstance(content, Mapping) or content.get('type') != PRIVATE or content.get('m.federate') is not False:
        return None
    data = content.get(PRIVATE)
    if not isinstance(data, Mapping) or set(data) != {'version', 'source_room_id', 'source_event_id'} or type(data.get('version')) is not int or data['version'] != 1:
        return None
    if not identifier(data['source_room_id'], '!') or not (data['source_event_id'] == '' or identifier(data['source_event_id'], '$')):
        return None
    return data


def valid_settings(data):
    return (isinstance(data, Mapping) and set(data) <= {'version', 'title', 'archived', 'autoArchiveSeconds', 'io.tavern.previous_event', 'updatedAt', 'activityStartedAt', 'reopen'}
            and type(data.get('version')) is int and data['version'] == 1
            and isinstance(data.get('title'), str) and 1 <= len(data['title'].strip()) <= 120
            and not re.search(r'[\x00-\x1f\x7f]', data['title'])
            and type(data.get('archived')) is bool
            and type(data.get('autoArchiveSeconds')) is int and data['autoArchiveSeconds'] in INTERVALS
            and type(data.get('reopen', False)) is bool)


class PrivateThreadPolicy:
    def __init__(self, owner, permissions, rank, native_power, valid_policy, valid_layout):
        self.owner, self.api = owner, owner.api
        self.permissions, self.rank, self.native_power, self.valid_policy = permissions, rank, native_power, valid_policy
        self.valid_layout = valid_layout

    async def source(self, data, actor):
        """Read current source and every canonical policy; missing context fails closed."""
        room_id = data['source_room_id']
        state = await self.api.get_room_state(room_id)
        create = value(state, 'm.room.create')
        if create.get('m.federate') is not False or create.get('type') in ('m.space', PRIVATE) or value(state, 'm.room.encryption').get('algorithm') != 'm.megolm.v1.aes-sha2':
            return None
        parents = {key for (kind, key), item in state.items() if kind == 'm.space.parent' and item.content.get('canonical') and item.content.get('via')}
        if not parents or len(parents) > 10:
            return None
        event = SimpleNamespace(type='m.room.encrypted', room_id=room_id, sender=actor)
        policies = await self.owner._policies(event, state)
        if {server for server, _, _ in policies} != parents:
            return None
        fresh = []
        for server, policy, observed in policies:
            current = await self.api.get_room_state(server)
            if not self.valid_policy(policy) or value(current, 'io.tavern.roles') != value(observed, 'io.tavern.roles') or value(current, 'io.tavern.server.layout') != value(observed, 'io.tavern.server.layout'):
                return None
            if ('io.tavern.server.layout', '') in current and not self.valid_layout(value(current, 'io.tavern.server.layout')):
                return None
            if value(current, 'm.room.create').get('type') != 'm.space' or value(current, 'm.room.create').get('m.federate') is not False or not value(current, 'm.space.child', room_id).get('via'):
                return None
            fresh.append((server, policy, current))
        return state, fresh

    def eligible(self, context, user):
        now = int(time.time() * 1000)
        return bool(self.api.is_mine(user) and all(value(state, 'm.room.member', user).get('membership') == 'join' and not banned(state, user, now) and not timeout_active(state, user, now) for state in [context[0]] + [parent for _, _, parent in context[1]]))

    def native(self, state, actor, operation, event_type=None):
        powers = value(state, 'm.room.power_levels')
        threshold = powers.get('events', {}).get(event_type, powers.get('events_default', 0)) if operation == 'send' else powers.get(operation, 0 if operation == 'invite' else 50)
        power = self.native_power(state, actor)
        return type(threshold) is int and power is not None and power >= threshold

    def native_state(self, state, actor, event_type):
        powers = value(state, 'm.room.power_levels')
        threshold = powers.get('events', {}).get(event_type, powers.get('state_default', 50))
        power = self.native_power(state, actor)
        return type(threshold) is int and power is not None and power >= threshold

    def allowed(self, context, data, actor, permission):
        return self.eligible(context, actor) and all(permission in self.permissions(policy, actor, data['source_room_id']) for _, policy, _ in context[1])

    def posting(self, context, data, actor):
        if not self.allowed(context, data, actor, 'send_messages') or not self.native(context[0], actor, 'send', 'm.room.encrypted') or not self.native(context[0], actor, 'send', 'm.room.message'):
            return False
        channel = value(context[0], 'io.tavern.channel')
        if channel and not valid_channel(channel) or channel.get('archived'):
            return False
        return channel.get('kind') not in ('read-only', 'announcement', 'rules') or (self.allowed(context, data, actor, 'manage_messages') and self.native(context[0], actor, 'redact'))

    async def create(self, actor, request):
        """Return an error string; the registered callback converts it to SynapseError."""
        creation = request.get('creation_content', {})
        if not isinstance(creation, Mapping) or (creation.get('type') != PRIVATE and PRIVATE not in creation):
            return None
        data = binding(creation)
        if not data or creation.get('additional_creators') or request.get('visibility', 'private') != 'private' or request.get('room_alias_name') or request.get('invite_3pid') or request.get('is_direct'):
            return 'Private discussions require an immutable source and private local room.'
        if set(request) - {'creation_content', 'visibility', 'preset', 'name', 'invite', 'initial_state', 'power_level_content_override', 'room_version', 'is_direct'}:
            return 'Unsupported private discussion creation option.'
        members, initial = request.get('invite', []), request.get('initial_state', [])
        if not isinstance(members, list) or len(members) > 50 or len(set(m for m in members if isinstance(m, str))) != len(members) or any(not identifier(m, '@') or m == actor for m in members) or not isinstance(initial, list):
            return 'Choose up to 50 distinct current source members.'
        if any(not isinstance(item, Mapping) or item.get('type') not in {SETTINGS, 'm.room.encryption', 'm.room.history_visibility', 'm.room.guest_access', 'm.room.join_rules'} or item.get('state_key', '') != '' for item in initial):
            return 'Private discussions cannot publish parent links or custom initial state.'
        settings = [item.get('content') for item in initial if item.get('type') == SETTINGS]
        if len(settings) != 1 or not valid_settings(settings[0]) or settings[0].get('io.tavern.previous_event') is not None:
            return 'Choose a discussion title and valid archive settings.'
        context = await self.source(data, actor)
        if not context or not self.posting(context, data, actor) or not self.allowed(context, data, actor, 'create_private_threads'):
            return 'Your current source membership or permissions do not allow private discussions.'
        if members and (not self.allowed(context, data, actor, 'invite') or not self.native(context[0], actor, 'invite')):
            return 'Your source permissions do not allow invitations.'
        if any(not self.eligible(context, member) for member in members):
            return 'Every invitee must currently belong to the source channel and its servers.'
        if data['source_event_id']:
            root = await self.api._store.get_event(data['source_event_id'], allow_none=True)
            if not root or root.room_id != data['source_room_id'] or root.type not in ('m.room.message', 'm.room.encrypted'):
                return 'The source message does not belong to this channel.'
        request.update(visibility='private', preset='private_chat', name=settings[0]['title'].strip(), is_direct=False)
        request['power_level_content_override'] = {'users_default': 0, 'events_default': 0, 'state_default': 50, 'invite': 0, 'kick': 50, 'ban': 50, 'redact': 50, 'events': {SETTINGS: 50}}
        request['initial_state'] = [
            {'type': 'm.room.encryption', 'state_key': '', 'content': {'algorithm': 'm.megolm.v1.aes-sha2'}},
            {'type': 'm.room.history_visibility', 'state_key': '', 'content': {'history_visibility': 'joined'}},
            {'type': 'm.room.join_rules', 'state_key': '', 'content': {'join_rule': 'invite'}},
            {'type': 'm.room.guest_access', 'state_key': '', 'content': {'guest_access': 'forbidden'}},
            {'type': SETTINGS, 'state_key': '', 'content': {**settings[0], 'io.tavern.previous_event': None}},
        ]
        return None

    async def check(self, event, state):
        creation = event.content if event.type == 'm.room.create' else value(state, 'm.room.create')
        marked = creation.get('type') == PRIVATE or PRIVATE in creation
        if not marked:
            if event.type == SETTINGS:
                return False, None
            if event.type == 'm.space.child' and event.content.get('via'):
                child = await self.api.get_room_state(event.state_key, [('m.room.create', '')])
                if value(child, 'm.room.create').get('type') == PRIVATE:
                    return False, None
            return None
        data = binding(creation)
        if not data:
            return False, None
        actor, kind, key = event.sender, event.type, getattr(event, 'state_key', None)
        # Native auth still checks self-leave; source changes never trap a member.
        if kind == 'm.room.member' and actor == key and event.content.get('membership') == 'leave':
            return True, None
        context = await self.source(data, actor)
        if not context or not self.eligible(context, actor):
            return False, None
        creator = event.sender if kind == 'm.room.create' else state[('m.room.create', '')].sender
        if kind == 'm.room.create':
            return self.allowed(context, data, actor, 'create_private_threads') and self.posting(context, data, actor), None
        if kind == 'm.room.member':
            membership = event.content.get('membership')
            if membership == 'join' and key == actor:
                previous = value(state, kind, actor).get('membership')
                return previous in ('invite', 'join') or actor == creator and previous is None, None
            if membership == 'invite':
                return (self.allowed(context, data, actor, 'invite') and self.native(context[0], actor, 'invite') and self.native(state, actor, 'invite') and self.eligible(context, key)), None
            if membership in ('leave', 'ban') and key != actor:
                need = 'ban' if membership == 'ban' or value(state, kind, key).get('membership') == 'ban' else 'kick'
                states = [state, context[0]] + [parent for _, _, parent in context[1]]
                return (self.allowed(context, data, actor, need) and all(self.native(current, actor, need) and self.native_power(current, actor) is not None and self.native_power(current, key) is not None and self.native_power(current, actor) > self.native_power(current, key) for current in states) and all(self.rank(policy, actor) > self.rank(policy, key) for _, policy, _ in context[1])), None
            return False, None
        if value(state, 'm.room.member', actor).get('membership') != 'join':
            return False, None
        if kind in {'m.room.encryption', 'm.room.history_visibility', 'm.room.join_rules', 'm.room.guest_access'}:
            expected = {'m.room.encryption': {'algorithm': 'm.megolm.v1.aes-sha2'}, 'm.room.history_visibility': {'history_visibility': 'joined'}, 'm.room.join_rules': {'join_rule': 'invite'}, 'm.room.guest_access': {'guest_access': 'forbidden'}}
            return actor == creator and key == '' and event.content == expected[kind], None
        if kind in {'m.room.power_levels', 'm.room.name'}:
            # Initial defaults only. No native authority grants, aliases, or room upgrades.
            return actor == creator and key == '' and (kind, '') not in state, None
        if kind == SETTINGS:
            previous = state.get((SETTINGS, ''))
            if key != '' or not valid_settings(event.content) or 'io.tavern.previous_event' not in event.content or event.content['io.tavern.previous_event'] != (previous.event_id if previous else None):
                return False, None
            power, powers = self.native_power(state, actor), value(state, 'm.room.power_levels')
            minimum = powers.get('events', {}).get(SETTINGS, powers.get('state_default', 50))
            if type(minimum) is not int or power is None or power < minimum:
                return False, None
            if (actor == creator and not self.allowed(context, data, actor, 'create_private_threads')) or (actor != creator and not (self.allowed(context, data, actor, 'manage_messages') and self.native(context[0], actor, 'redact'))):
                return False, None
            now, old = int(time.time() * 1000), value(state, SETTINGS)
            reset = not previous or event.content.get('reopen', False) or old.get('archived') and not event.content['archived'] or not old.get('autoArchiveSeconds') and bool(event.content['autoArchiveSeconds'])
            activity = await self.owner.threads.activity(event.room_id, '$private', now, reset=reset)
            replacement = event.get_dict()
            replacement['content'] = {**dict(event.content), 'title': event.content['title'].strip(), 'updatedAt': now, 'activityStartedAt': activity or now, 'reopen': False}
            return True, replacement
        if kind == 'm.room.redaction':
            target = getattr(event, 'redacts', None) or event.content.get('redacts')
            original = await self.api._store.get_event(target, allow_none=True) if target else None
            return bool(original and original.room_id == event.room_id and original.type not in PROTECTED and self.native(state, actor, 'send', kind) and self.native(context[0], actor, 'send', kind) and (original.sender == actor or self.allowed(context, data, actor, 'manage_messages') and self.native(context[0], actor, 'redact') and self.native(state, actor, 'redact'))), None
        # Native reaction/pin metadata remains local to this private room. Message
        # contents must be encrypted; unknown state/call events fail closed.
        if kind not in {'m.room.encrypted', 'm.reaction', 'm.room.pinned_events'}:
            return False, None
        settings = value(state, SETTINGS)
        if not valid_settings(settings) or settings['archived'] or value(state, 'm.room.history_visibility').get('history_visibility') != 'joined' or value(state, 'm.room.encryption').get('algorithm') != 'm.megolm.v1.aes-sha2':
            return False, None
        interval, now = settings['autoArchiveSeconds'], int(time.time() * 1000)
        if interval and await self.owner.threads.activity(event.room_id, '$private', now, interval) is None:
            return False, None
        channel = value(context[0], 'io.tavern.channel')
        if channel and not valid_channel(channel) or channel.get('archived'):
            return False, None
        if kind == 'm.reaction':
            relation = event.content.get('m.relates_to', {})
            if key is not None or not isinstance(relation, Mapping) or relation.get('rel_type') != 'm.annotation' or not identifier(relation.get('event_id'), '$') or not isinstance(relation.get('key'), str) or not 1 <= len(relation['key']) <= 2048 or re.search(r'[\x00-\x1f\x7f]', relation['key']):
                return False, None
            target = await self.api._store.get_event(relation['event_id'], allow_none=True)
            return bool(target and target.room_id == event.room_id and target.type == 'm.room.encrypted' and self.allowed(context, data, actor, 'add_reactions') and self.native(context[0], actor, 'send', kind) and self.native(state, actor, 'send', kind)), None
        if kind == 'm.room.pinned_events':
            pinned = event.content.get('pinned')
            if key != '' or set(event.content) != {'pinned'} or not isinstance(pinned, (list, tuple)) or len(pinned) > 100 or any(not identifier(identity, '$') for identity in pinned) or len(set(pinned)) != len(pinned) or not self.allowed(context, data, actor, 'pin_messages') or not self.native_state(context[0], actor, kind) or not self.native_state(state, actor, kind):
                return False, None
            for identity in pinned:
                target = await self.api._store.get_event(identity, allow_none=True)
                if not target or target.room_id != event.room_id or target.type != 'm.room.encrypted':
                    return False, None
            return True, None
        if key is not None or not self.posting(context, data, actor) or not self.native(state, actor, 'send', kind):
            return False, None
        # Reuse the SOURCE channel's durable per-user cooldown so opening another
        # private room cannot bypass its slow mode. Rejected attempts do not extend
        # the private inactivity ledger.
        seconds = channel.get('slowModeSeconds', 0)
        moderator = self.allowed(context, data, actor, 'manage_messages') and self.native(context[0], actor, 'redact')
        if seconds and not moderator:
            source_event = SimpleNamespace(room_id=data['source_room_id'], sender=actor, event_id=event.event_id)
            if not await self.owner.channels.reserve_slow_mode(source_event, seconds, now):
                return False, None
        if interval:
            return await self.owner.threads.activity(event.room_id, '$private', now, interval, record=True, event_id=event.event_id) is not None, None
        return True, None

    async def visibility(self, room_id, state_events, new_visibility):
        return value(state_events, 'm.room.create').get('type') != PRIVATE or new_visibility == 'private'

    async def threepid(self, medium, address, state_events):
        return value(state_events, 'm.room.create').get('type') != PRIVATE
