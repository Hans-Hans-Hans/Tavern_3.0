"""Server-scoped nickname overrides without membership/profile impersonation."""
from collections.abc import Mapping
import re
import time

try:
    from member_state import member_state_target, member_state_revision_matches
    from channel_policy import timeout_active
except ImportError:
    from synapse_modules.member_state import member_state_target, member_state_revision_matches
    from synapse_modules.channel_policy import timeout_active

NICKNAME = 'io.tavern.server.nickname'


def check_nickname(event, state, policies, permissions, rank, native_power):
    if event.type != NICKNAME:
        return True
    actor, value = event.sender, event.content
    try:
        target = member_state_target(getattr(event, 'state_key', None))
    except ValueError:
        return False
    if target == actor:
        return False
    if not isinstance(value, Mapping) or set(value) != {'version', 'name', 'io.tavern.previous_event'} or type(value.get('version')) is not int or value['version'] != 1:
        return False
    name = value['name']
    if name is not None and (not isinstance(name, str) or not 1 <= len(name) <= 60 or name != name.strip() or re.search(r'[\x00-\x1f\x7f]', name)):
        return False
    create = state.get(('m.room.create', ''))
    if not create or create.content.get('type') != 'm.space' or create.content.get('m.federate', True) is not False:
        return False
    # This is a server-wide permission. A child channel cannot provide a grant
    # or write an override that applies to other channels.
    if len(policies) != 1 or policies[0][0] != event.room_id:
        return False
    for user in (actor, target):
        member = state.get(('m.room.member', user))
        if not member or member.content.get('membership') != 'join':
            return False
    if not member_state_revision_matches(value, state, NICKNAME, target):
        return False
    powers = state.get(('m.room.power_levels', ''))
    power = powers.content if powers else {}
    threshold = power.get('events', {}).get(NICKNAME, power.get('state_default', 50))
    actor_power, target_power = native_power(state, actor), native_power(state, target)
    if type(threshold) is not int or actor_power is None or target_power is None or actor_power < threshold or actor_power <= target_power:
        return False
    if timeout_active(state, actor, int(time.time() * 1000)):
        return False
    policy = policies[0][1]
    return 'manage_nicknames' in permissions(policy, actor) and rank(policy, target) < rank(policy, actor)
