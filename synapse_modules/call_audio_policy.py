"""Durable, independent SFU audio restrictions; native Matrix auth is a ceiling.

This module authorizes state, not media delivery. The gateway and the pinned SFU
must project the saved flags for every device and reconnect before enabling it.
Nothing here mutes Matrix P2P calls or removes a member from a room.
"""
from collections.abc import Mapping
from dataclasses import dataclass
import re
import time

try:
    from conference_publication import MARKER as PUBLICATION_VERSION
    from channel_policy import value, timeout_active
    from temporary_ban import active as banned
    from member_state import member_state_keys
except ImportError:
    from synapse_modules.conference_publication import MARKER as PUBLICATION_VERSION
    from synapse_modules.channel_policy import value, timeout_active
    from synapse_modules.temporary_ban import active as banned
    from synapse_modules.member_state import member_state_keys

AUDIO = 'io.tavern.call.audio'
PREVIOUS = 'io.tavern.previous_event'
PRIVATE = 'io.tavern.private_thread'
MAX_SCOPES = 32
MAX_DEPTH = 8
FLAGS = {'muted': 'mute_members', 'deafened': 'deafen_members'}


def identifier(item, prefix, maximum=1024):
    return (isinstance(item, str) and 2 <= len(item) <= maximum and item.startswith(prefix)
            and not re.search(r'[\s\x00-\x1f\x7f\ud800-\udfff]', item))


def user_id(item):
    return identifier(item, '@', 255) and len(item.encode('utf-8')) <= 255 and bool(re.fullmatch(r'@[^:]+:.+', item))


def audio_state_key(target):
    """Stable Matrix rooms reserve @-prefixed state keys for that account.

    Replace the sigil, preserving the native 255-byte limit and a reversible
    exact identity. No alternate spellings or hashed identity claims are used.
    """
    if not user_id(target):
        raise ValueError('Invalid audio restriction target')
    return '_' + target[1:]


def audio_target(key):
    if not isinstance(key, str) or not key.startswith('_'):
        raise ValueError('Invalid audio restriction state key')
    target = '@' + key[1:]
    if audio_state_key(target) != key:
        raise ValueError('Invalid audio restriction state key')
    return target


def valid_audio(data):
    return (isinstance(data, Mapping) and set(data) == {'version', 'muted', 'deafened', PREVIOUS}
            and type(data.get('version')) is int and data['version'] == 1
            and all(type(data.get(key)) is bool for key in FLAGS)
            and (data[PREVIOUS] is None or identifier(data[PREVIOUS], '$')))


def audio_flags(state, target):
    """Absent is unrestricted; malformed or redacted persisted state is an error."""
    if not user_id(target):
        raise ValueError('Invalid audio restriction target')
    item = state.get((AUDIO, audio_state_key(target)))
    if not item:
        return {'muted': False, 'deafened': False}
    if not valid_audio(item.content) or not identifier(getattr(item, 'event_id', None), '$'):
        raise ValueError('The saved audio restriction needs repair')
    return {key: item.content[key] for key in FLAGS}


def linked(data):
    via = data.get('via')
    if not via:
        return False
    if (not isinstance(via, (list, tuple)) or len(via) > 32
            or any(not isinstance(server, str) or not 1 <= len(server) <= 255
                   or re.search(r'[\s\x00-\x1f\x7f/\\?#\ud800-\udfff]', server) for server in via)):
        raise ValueError('Invalid audio scope routing metadata')
    return True


@dataclass(frozen=True)
class AudioScope:
    room_id: str
    state: Mapping
    # A shared ancestor can be reached through several immediate children.
    # Every path contributes its category/channel grants; none wins by order.
    contexts: tuple


def snapshot(data):
    # Synapse1.160 exposes immutable Rust-backed Mapping values, not dicts.
    if isinstance(data, Mapping):
        return tuple(sorted((key, snapshot(item)) for key, item in data.items()))
    if isinstance(data, (list, tuple)):
        return tuple(snapshot(item) for item in data)
    if data is None or type(data) in (str, bool, int, float):
        return data
    raise ValueError('Invalid native state')


def scope_fingerprint(scopes, actor, target):
    """Capture before any further await; never retain mutable fixture dictionaries."""
    result = []
    for scope in scopes:
        keys = {('m.room.create', ''), ('m.room.power_levels', ''), ('io.tavern.roles', ''),
                ('io.tavern.server.layout', ''), ('m.room.encryption', ''),
                ('m.room.member', actor), ('m.room.member', target)}
        keys.update((kind, key) for kind in ('io.tavern.timeout', 'io.tavern.tempban') for key in member_state_keys(actor))
        if user_id(target):
            keys.add((AUDIO, audio_state_key(target)))
        keys.update((kind, key) for kind, key in scope.state if kind == 'm.space.parent')
        keys.update(('m.space.child', child) for child in scope.contexts if child != scope.room_id)
        events = []
        for key in sorted(keys):
            item = scope.state.get(key)
            events.append((key, None if item is None else
                           (getattr(item, 'event_id', None), getattr(item, 'sender', None), snapshot(item.content))))
        result.append((scope.room_id, scope.contexts, tuple(events)))
    return tuple(result)


def effective_audio(scopes, target):
    """OR each restriction. An explicit child clear never clears a parent flag.

    Raises on malformed state; callers must deny/defer media, never default to
    unrestricted. Issuer membership and current feature enablement are irrelevant
    when reading a durable restriction that was already accepted.
    """
    result = {'muted': False, 'deafened': False, 'sources': []}
    for scope in scopes:
        flags = audio_flags(scope.state, target)
        for key in FLAGS:
            result[key] = result[key] or flags[key]
        item = scope.state.get((AUDIO, audio_state_key(target)))
        if item:
            result['sources'].append({'roomId': scope.room_id, 'eventId': item.event_id, **flags})
    return result


def link_fingerprint(scopes, actor):
    # Any target's saved state makes a relationship protected. Capture all
    # entries, including explicit clears and malformed records, before awaiting.
    restrictions = tuple((scope.room_id, tuple(sorted(
        (key, getattr(item, 'event_id', None), getattr(item, 'sender', None), snapshot(item.content))
        for (kind, key), item in scope.state.items() if kind == AUDIO))) for scope in scopes)
    return scope_fingerprint(scopes, actor, actor), restrictions


class AudioModerationPolicy:
    def __init__(self, config, api, model):
        self.enabled = config.get('audio_moderation_enabled', False)
        if type(self.enabled) is not bool:
            raise ValueError('audio_moderation_enabled must be a boolean')
        self.api, self.model = api, model

    async def scopes(self, room_id, state):
        """Own scope and every reciprocal canonical ancestor, without role shortcuts.

        Private discussions are deliberately unsupported by the current RTC
        gateway. Their immutable source cannot be replaced with a claimed parent.
        """
        found, contexts, fetched, heights = {}, {}, {}, {}

        async def visit(identity, current, path, depth, child=None):
            if identity in path or depth > MAX_DEPTH:
                raise ValueError('Cyclic or excessive audio scope depth')
            creation = value(current, 'm.room.create')
            if (not identifier(identity, '!') or creation.get('m.federate') is not False
                    or creation.get('type') == PRIVATE or PRIVATE in creation
                    or child is not None and creation.get('type') != 'm.space'):
                raise ValueError('Invalid local audio scope')
            if identity not in found:
                if len(found) >= MAX_SCOPES:
                    raise ValueError('Too many audio scopes')
                found[identity] = current
            contexts.setdefault(identity, set()).add(child or identity)
            if identity in heights:
                if depth + heights[identity] > MAX_DEPTH:
                    raise ValueError('Excessive audio scope depth')
                return heights[identity]
            parents = []
            for (kind, key), item in current.items():
                if kind != 'm.space.parent':
                    continue
                data = item.content
                if type(data.get('canonical', False)) is not bool:
                    raise ValueError('Invalid canonical audio parent')
                if data.get('canonical') is True and linked(data):
                    if not identifier(key, '!'):
                        raise ValueError('Invalid canonical audio parent')
                    parents.append(key)
            if len(parents) > MAX_SCOPES:
                raise ValueError('Too many canonical audio parents')
            height = 0
            for parent_id in sorted(parents):
                if parent_id in found:
                    parent = found[parent_id]
                elif parent_id in fetched:
                    parent = fetched[parent_id]
                else:
                    # Include failed/nonreciprocal reads in the work budget too.
                    if len(fetched) >= MAX_SCOPES - 1:
                        raise ValueError('Too many audio parent reads')
                    parent = await self.api.get_room_state(parent_id)
                    fetched[parent_id] = parent
                if linked(value(parent, 'm.space.child', identity)):
                    height = max(height, 1 + await visit(parent_id, parent, path | {identity}, depth + 1, identity))
            heights[identity] = height
            return height

        await visit(room_id, state, set(), 0)
        return tuple(AudioScope(identity, current, tuple(sorted(contexts[identity])))
                     for identity, current in sorted(found.items()))

    def may_write(self, event, state, scopes):
        actor, data = event.sender, event.content
        try:
            target = audio_target(getattr(event, 'state_key', None))
        except ValueError:
            return False
        if (not user_id(actor) or not user_id(target) or actor == target or not valid_audio(data)
                or not any(scope.room_id == event.room_id and scope.state is state
                           and scope.room_id in scope.contexts for scope in scopes)):
            return False
        previous = state.get((AUDIO, event.state_key))
        if previous and not identifier(getattr(previous, 'event_id', None), '$'):
            return False
        if data[PREVIOUS] != (previous.event_id if previous else None):
            return False
        try:
            before = audio_flags(state, target)
            changed = {key for key in FLAGS if data[key] != before[key]}
        except ValueError:
            # Repairing malformed state needs both independent capabilities.
            before, changed = {'muted': False, 'deafened': False}, set(FLAGS)
        if not changed:
            return False
        if not self.enabled and any(data[key] for key in changed):
            return False  # Disabling runtime support still permits authorized repair/clear.
        if any(data[key] and not before[key] for key in changed) and value(state, 'm.room.member', target).get('membership') != 'join':
            return False
        grants = self.permissions_for(state, scopes, actor, target)
        return all(grants['mute' if key == 'muted' else 'deafen'] for key in changed)

    def permissions_for(self, state, scopes, actor, target):
        """Inspect current authority without inventing a mutation as a probe.

        This ignores runtime enablement and whether a new true flag is admissible.
        The caller still uses may_write for every actual change, and refreshes
        the same resolved state snapshots after asynchronous work.
        """
        denied = {'mute': False, 'deafen': False}
        if (not user_id(actor) or not user_id(target) or actor == target
                or not any(scope.state is state and scope.room_id in scope.contexts for scope in scopes)
                or value(state, 'm.room.member', target).get('membership') != 'join' and (AUDIO, audio_state_key(target)) not in state):
            return denied
        creation = value(state, 'm.room.create')
        if creation.get('type') != 'm.space' and (
                len(scopes) < 2 or value(state, 'm.room.encryption').get('algorithm') != 'm.megolm.v1.aes-sha2'):
            return denied
        powers = value(state, 'm.room.power_levels')
        if not isinstance(powers.get('events', {}), Mapping):
            return denied
        thresholds = (powers.get('kick', 50), powers.get('events', {}).get(AUDIO, powers.get('state_default', 50)))
        actor_power, target_power = self.model.native_member_power(state, actor), self.model.native_member_power(state, target)
        if (any(type(item) is not int for item in thresholds) or actor_power is None or target_power is None
                or actor_power < max(thresholds) or actor_power <= target_power):
            return denied
        now = int(time.time() * 1000)
        granted = set(FLAGS.values())
        for scope in scopes:
            current = scope.state
            if (value(current, 'm.room.member', actor).get('membership') != 'join'
                    or timeout_active(current, actor, now) or banned(current, actor, now)):
                return denied
            if (self.model.POLICY, '') not in current:
                continue
            if value(current, 'm.room.create').get('type') != 'm.space':
                return denied
            policy = value(current, self.model.POLICY)
            layout = value(current, self.model.LAYOUT)
            if not self.model.valid_policy(policy) or (self.model.LAYOUT, '') in current and not self.model.valid_layout(layout):
                return denied
            policy = self.model.ResolvedPolicy(policy, layout)
            if self.model.rank(policy, actor) <= self.model.rank(policy, target):
                return denied
            for context in scope.contexts:
                granted &= self.model.permissions(policy, actor, context)
        return {'mute': 'mute_members' in granted, 'deafen': 'deafen_members' in granted}

    async def protect_links(self, event, state):
        """A channel owner cannot shed inherited restrictions by unlinking it."""
        kind, key = event.type, getattr(event, 'state_key', None)
        previous = value(state, kind, key)
        if kind == 'm.space.parent' and previous.get('canonical') is not True:
            return True  # A noncanonical link did not carry this restriction.
        if not previous.get('via') or (event.content.get('via') and
                (kind != 'm.space.parent' or previous.get('canonical') is not True or event.content.get('canonical') is True)):
            return True
        parent_id = event.room_id if kind == 'm.space.child' else key
        parent = state if kind == 'm.space.child' else await self.api.get_room_state(parent_id)
        # Ordinary unrelated spaces keep their existing native behavior.
        if value(parent, 'm.room.create').get('m.federate') is not False:
            return True
        scopes = await self.scopes(parent_id, parent)
        before = link_fingerprint(scopes, event.sender)
        original_link = state.get((kind, key))
        original_link = (getattr(original_link, 'event_id', None), snapshot(previous))
        fresh = await self.api.get_room_state(event.room_id)
        current_link = fresh.get((kind, key))
        if original_link != (getattr(current_link, 'event_id', None), snapshot(value(fresh, kind, key))):
            return False
        parent = fresh if kind == 'm.space.child' else await self.api.get_room_state(parent_id)
        latest = await self.scopes(parent_id, parent)
        if before != link_fingerprint(latest, event.sender):
            return False
        for scope in latest:
            role_policy = value(scope.state, self.model.POLICY)
            if (any(kind == AUDIO for kind, _ in scope.state) or PUBLICATION_VERSION in role_policy
                    or (self.model.POLICY, '') in scope.state and not self.model.valid_policy(role_policy)):
                create = scope.state.get(('m.room.create', ''))
                if (not create or create.sender != event.sender
                        or value(scope.state, 'm.room.member', event.sender).get('membership') != 'join'):
                    return False
        return True

    async def check(self, event, state):
        """Return None for unrelated events, otherwise an authoritative decision."""
        try:
            if event.type == AUDIO:
                scopes = await self.scopes(event.room_id, state)
                if not self.may_write(event, state, scopes):
                    return False
                target = audio_target(event.state_key)
                before = scope_fingerprint(scopes, event.sender, target)
                fresh = await self.api.get_room_state(event.room_id)
                latest = await self.scopes(event.room_id, fresh)
                return (before == scope_fingerprint(latest, event.sender, target)
                        and self.may_write(event, fresh, latest))
            if event.type == 'm.room.redaction':
                target = getattr(event, 'redacts', None) or event.content.get('redacts')
                original = await self.api._store.get_event(target, allow_none=True) if target else None
                if original and original.type == AUDIO:
                    return False
                if original and original.type in {'m.space.parent', 'm.space.child'}:
                    # Redaction is never the explicit owner-authorized detach path.
                    from types import SimpleNamespace
                    removal = SimpleNamespace(type=original.type, state_key=original.state_key,
                        room_id=event.room_id, sender='', content={})
                    if not await self.protect_links(removal, state):
                        return False
            if event.type in {'m.space.parent', 'm.space.child'} and not await self.protect_links(event, state):
                return False
        except Exception:
            return False  # Missing state and malformed topology never authorize a write.
        return None
