"""Expiring admission/write restrictions; native Matrix auth remains the ceiling.

The state deadline uses server time on every event, so expiry does not require
retaining a moderator token or a scheduled privileged unban operation.
"""
from collections.abc import Mapping
import re
import time

try:
    from channel_policy import value, native_power
except ImportError:
    from synapse_modules.channel_policy import value, native_power

TEMPBAN = 'io.tavern.tempban'
MAX_DURATION_MS = 28 * 86400000


def active(state, user, now):
    if (TEMPBAN, user) not in state:
        return False
    restriction = value(state, TEMPBAN, user)
    until = restriction.get('until')
    # Corrupted or redacted existing restriction state cannot silently lift it.
    return restriction.get('version') != 1 or type(until) is not int or until < 0 or until > now


def cleanup(event, state):
    key = getattr(event, 'state_key', None)
    if event.type == 'm.room.member':
        return key == event.sender and event.content.get('membership') == 'leave'
    if event.type == 'org.matrix.msc3401.call.member':
        previous = state.get((event.type, key))
        return bool(previous and previous.sender == event.sender and (not event.content or event.content.get('memberships') == []))
    return event.type in {'m.call.hangup', 'm.call.reject'}


class TemporaryBanPolicy:
    def __init__(self, api, permissions, rank):
        self.api, self.permissions, self.rank = api, permissions, rank

    async def check(self, event, state, policies):
        now = int(time.time() * 1000)
        actor, kind, key = event.sender, event.type, getattr(event, 'state_key', None)
        states = [state] + [parent for _, _, parent in policies]
        if any(active(current, actor, now) for current in states) and not cleanup(event, state):
            return False
        if kind == 'm.room.member' and event.content.get('membership') in {'join', 'invite', 'knock'}:
            if any(active(current, key, now) for current in states):
                return False
        if kind == TEMPBAN:
            if not isinstance(key, str) or not re.fullmatch(r'@[^\s/\\?#]{1,254}:[^\s/\\?#]{1,254}', key) or key == actor or not isinstance(event.content, Mapping):
                return False
            until, reason = event.content.get('until'), event.content.get('reason', '')
            if event.content.get('version') != 1 or type(until) is not int or not (until == 0 or now < until <= now + MAX_DURATION_MS) or not isinstance(reason, str) or len(reason) > 500:
                return False
            if 'io.tavern.previous_event' in event.content:
                current = state.get((TEMPBAN, key))
                if event.content['io.tavern.previous_event'] != (current.event_id if current else None):
                    return False
            powers = value(state, 'm.room.power_levels')
            threshold = max(powers.get('ban', 50), powers.get('events', {}).get(TEMPBAN, powers.get('state_default', 50)))
            if native_power(state, actor) < threshold or native_power(state, actor) <= native_power(state, key):
                return False
            for _, policy, parent in policies:
                if value(parent, 'm.room.member', actor).get('membership') != 'join' or 'ban' not in self.permissions(policy, actor, event.room_id) or self.rank(policy, key) >= self.rank(policy, actor):
                    return False
        if kind == 'm.room.redaction':
            target = getattr(event, 'redacts', None) or event.content.get('redacts')
            original = await self.api._store.get_event(target, allow_none=True) if target else None
            if original and original.type == TEMPBAN:
                return False
        return True
