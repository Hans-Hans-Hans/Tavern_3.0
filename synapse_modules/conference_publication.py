"""Versioned role publication rights; media kind is enforceable, origin is not."""
from collections.abc import Mapping

MARKER = 'callPublicationVersion'
PUBLICATION = ('speak', 'video', 'screen_share')
PREVIOUS = 'io.tavern.previous_event'


def snapshot(value):
    # Native Rust event mappings deliberately do not support deepcopy/pickle.
    if isinstance(value, Mapping):
        return {key: snapshot(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [snapshot(item) for item in value]
    return value


def valid_version(policy):
    if MARKER in policy:
        return type(policy[MARKER]) is int and policy[MARKER] == 1
    # Do not accept a policy that appears restrictive but is interpreted as legacy.
    for role in policy.get('roles', ()):
        if set(role.get('permissions', ())) & set(PUBLICATION):
            return False
    for name in ('overrides', 'categoryOverrides'):
        for targets in policy.get(name, {}).values():
            for kind in ('roles', 'users'):
                if any(set(values) & set(PUBLICATION) for values in targets.get(kind, {}).values()):
                    return False
    return True


def migration(previous):
    result = snapshot(previous)
    result.pop(PREVIOUS, None)
    result[MARKER] = 1
    for role in result['roles']:
        if role['id'] == 'everyone':
            role['permissions'] += [grant for grant in PUBLICATION if grant not in role['permissions']]
    return result


def may_transition(previous, proposed, actor):
    if MARKER in previous:
        return proposed.get(MARKER) == 1 and type(proposed.get(MARKER)) is int
    if MARKER not in proposed:
        return True
    candidate = snapshot(proposed)
    candidate.pop(PREVIOUS, None)
    return actor == previous['owner'] and candidate == migration(previous)


def effective_publication(scopes, user, model):
    """Intersect every canonical path; an own policy never hides an ancestor."""
    granted = set(PUBLICATION)
    governed = False
    joined = True
    for scope in scopes:
        if (model.POLICY, '') not in scope.state:
            continue
        data = scope.state[(model.POLICY, '')].content
        layout_event = scope.state.get((model.LAYOUT, ''))
        if not model.valid_policy(data) or layout_event and not model.valid_layout(layout_event.content):
            raise ValueError('Invalid publication policy')
        member = scope.state.get(('m.room.member', user))
        if not member or member.content.get('membership') != 'join':
            joined = False
            granted.clear()
        policy = model.ResolvedPolicy(data, layout_event.content if layout_event else {})
        governed |= MARKER in data
        for context in scope.contexts:
            granted &= model.permissions(policy, user, context)
    return {'managed': governed, 'joined': joined, **{name: name in granted for name in PUBLICATION}}
