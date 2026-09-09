"""Bounded community defaults and welcome references, before native Matrix auth."""
import re
from collections.abc import Mapping

NOTIFICATIONS = 'io.tavern.notification.defaults'
ONBOARDING = 'io.tavern.server.onboarding'


def check_settings(event, state):
    if event.type not in (NOTIFICATIONS, ONBOARDING):
        return True
    value = event.content
    if getattr(event, 'state_key', None) != '' or not isinstance(value, Mapping) or type(value.get('version')) is not int or value['version'] != 1:
        return False
    if 'io.tavern.previous_event' in value:
        previous = state.get((event.type, ''))
        if value['io.tavern.previous_event'] != (getattr(previous, 'event_id', None) if previous else None):
            return False
    if event.type == NOTIFICATIONS:
        return set(value) <= {'version', 'mode', 'io.tavern.previous_event'} and value.get('mode') in ('inherit', 'all', 'mentions', 'nothing')
    create = state.get(('m.room.create', ''))
    if not create or create.content.get('type') != 'm.space':
        return False
    if set(value) - {'version', 'enabled', 'startChannel', 'welcomeChannel', 'rulesChannel', 'recommended', 'interests', 'io.tavern.previous_event'} or type(value.get('enabled')) is not bool:
        return False

    def channel(room_id, optional=False):
        if room_id == '' and optional:
            return True
        if not isinstance(room_id, str) or not room_id.startswith('!') or len(room_id) > 255:
            return False
        child = state.get(('m.space.child', room_id))
        return bool(child and isinstance(child.content.get('via'), (list, tuple)) and child.content['via'])

    def channels(values):
        return isinstance(values, (list, tuple)) and len(values) <= 20 and all(channel(room_id) for room_id in values) and len(set(values)) == len(values)

    if not all(channel(value.get(key, ''), True) for key in ('startChannel', 'welcomeChannel', 'rulesChannel')) or not channels(value.get('recommended')):
        return False
    interests = value.get('interests')
    if not isinstance(interests, (list, tuple)) or len(interests) > 12:
        return False
    seen = set()
    for interest in interests:
        if not isinstance(interest, Mapping) or set(interest) != {'id', 'label', 'channels'}:
            return False
        key, label = interest.get('id'), interest.get('label')
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', key) or key in seen or not isinstance(label, str) or not label.strip() or len(label) > 80 or not channels(interest.get('channels')):
            return False
        seen.add(key)
    return True
