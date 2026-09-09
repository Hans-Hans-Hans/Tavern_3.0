"""Canonical keys for moderator-owned per-member state in stable Matrix rooms.

Matrix reserves @-prefixed state keys for that account. Replacing only the sigil
preserves the 255-byte native limit. A canonical event, including an explicit
clear or malformed value, supersedes its legacy key; it never falls back by
timestamp, content validity, or sender. Legacy state remains readable until an
authorized revision-checked canonical write replaces its effect.
"""
import re


def member_state_key(target):
    if (not isinstance(target, str) or not re.fullmatch(r'@[^:\s/\\?#\x00-\x1f\x7f\ud800-\udfff]+:[^\s/\\?#\x00-\x1f\x7f\ud800-\udfff]+', target)
            or len(target.encode('utf-8')) > 255):
        raise ValueError('Invalid member state target')
    return '_' + target[1:]


def member_state_target(key):
    if not isinstance(key, str) or not key.startswith('_'):
        raise ValueError('Invalid member state key')
    target = '@' + key[1:]
    if member_state_key(target) != key:
        raise ValueError('Invalid member state key')
    return target


def member_state_keys(target):
    return (member_state_key(target), target)


def member_state_event(state, kind, target):
    try:
        keys = member_state_keys(target)
    except ValueError:
        return None
    for key in keys:
        if (kind, key) in state:
            return state[(kind, key)]
    return None


def member_state_revision_matches(data, state, kind, target):
    if 'io.tavern.previous_event' not in data:
        return False
    current = member_state_event(state, kind, target)
    previous = getattr(current, 'event_id', None) if current else None
    if current and (not isinstance(previous, str) or not previous.startswith('$')):
        return False
    return data['io.tavern.previous_event'] == previous
