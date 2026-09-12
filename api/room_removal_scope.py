"""Native ownership and the exact reviewable scope of room removal.

This module performs reads only. A server owner's authority is established from
the immutable native Space creator and its current role policy/membership.
Reciprocal links cannot authorize deletion of a shared or foreign channel.
"""
import hashlib
import json
from urllib.parse import quote

try:
    from .server import APIError
    from .room_authority import content, room_authority, room_id, state
except ImportError:
    from server import APIError
    from room_authority import content, room_authority, room_id, state

LIMIT = 100


def space_owner(current, actor, model):
    create = current.get(('m.room.create', ''))
    policy = content(current, model.POLICY)
    return bool(create and create.sender == actor and create.content.get('type') == 'm.space'
                and create.content.get('m.federate') is False and model.valid_policy(policy)
                and policy.get('owner') == actor
                and content(current, 'm.room.member', actor).get('membership') == 'join')


def snapshot(current):
    """State revisions bind review to actual ownership, membership and hierarchy."""
    kinds = {'m.room.create', 'm.room.name', 'm.room.power_levels', 'm.room.member',
             'm.space.parent', 'm.space.child', 'io.tavern.roles', 'io.tavern.server.layout'}
    values = [[kind, key, event.event_id, event.sender, event.content]
              for (kind, key), event in sorted(current.items()) if kind in kinds]
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


async def removal_scope(service, session, identity):
    identity, actor = room_id(identity), session['user_id']
    authority = await room_authority(service, session, identity)
    model, original = authority.model, authority.state
    creation = content(original, 'm.room.create')
    if creation.get('m.federate') is not False or ('m.room.tombstone', '') in original:
        raise APIError(403, 'Only local Tavern rooms can be deleted here.')
    kind = 'server' if creation.get('type') == 'm.space' else 'channel'
    reads, servers = {identity: original}, {}

    async def read(value):
        value = room_id(value)
        if value not in reads:
            if len(reads) > LIMIT * 2:
                raise APIError(400, 'Delete channels in smaller groups before deleting this server.')
            reads[value] = await state(service, value)
        return reads[value]

    async def parent_owner(parent_id):
        # Validate the actor's ordinary server membership before using its
        # privileged state view, even when called from a child room review.
        if parent_id not in servers:
            member = await service.matrix('GET', '/_matrix/client/v3/rooms/' + quote(parent_id, safe='')
                                          + '/state/m.room.member/' + quote(actor, safe=''), token=service.store.open(session['token']))
            if member.get('membership') != 'join':
                raise APIError(403, 'Join the parent server before reviewing channel deletion.')
            current = await read(parent_id)
            if not space_owner(current, actor, model):
                raise APIError(403, 'Only the current native server owner can delete its channels or server.')
            servers[parent_id] = current
        return servers[parent_id]

    async def child(value, expected_parent=None):
        current = await read(value)
        create = content(current, 'm.room.create')
        if (create.get('type') or create.get('m.federate') is not False
                or content(current, 'm.room.encryption').get('algorithm') != 'm.megolm.v1.aes-sha2'
                or ('m.room.tombstone', '') in current):
            raise APIError(403, 'Remove nested servers or unsupported rooms before deleting this server.')
        parents = [key for (event_type, key), event in current.items()
                   if event_type == 'm.space.parent' and event.content.get('canonical') is True and event.content.get('via')]
        if not parents or len(parents) > 32:
            raise APIError(403, 'Deletion here requires a channel with a native parent server. Direct messages are excluded.')
        scopes = []
        for parent_id in parents:
            parent = await parent_owner(room_id(parent_id))
            if content(parent, 'm.space.child', value).get('via'):
                scopes.append(parent_id)
        if not scopes or expected_parent is not None and scopes != [expected_parent]:
            raise APIError(403, 'Detach channels shared with another server before deleting this server.')
        return {'id': value, 'name': room_name(current, value), 'kind': 'channel', 'parents': sorted(scopes),
                'members': sum(event.content.get('membership') in {'join', 'invite'} for (event_type, _), event in current.items() if event_type == 'm.room.member')}

    if kind == 'server':
        if not space_owner(original, actor, model):
            raise APIError(403, 'Only the current native server owner can delete this server.')
        servers[identity] = original
        children = sorted(key for (event_type, key), event in original.items() if event_type == 'm.space.child' and event.content.get('via'))
        if len(children) > LIMIT:
            raise APIError(400, 'Delete channels in smaller groups before deleting this server.')
        targets = [await child(value, identity) for value in children]
        targets.append({'id': identity, 'name': room_name(original, identity), 'kind': 'server', 'parents': [],
                        'members': sum(event.content.get('membership') in {'join', 'invite'} for (event_type, _), event in original.items() if event_type == 'm.room.member')})
    else:
        targets = [await child(identity)]
    # A stale review must not approve a later room link or role assignment.
    revisions = {value: snapshot(current) for value, current in reads.items()}
    for value, previous in revisions.items():
        if snapshot(await state(service, value)) != previous:
            raise APIError(409, 'Room ownership, membership or channels changed. Review deletion again.')
    return {'version': 1, 'root': identity, 'kind': kind, 'name': room_name(original, identity),
            'targets': targets, 'revisions': revisions}


def room_name(current, identity):
    value = content(current, 'm.room.name').get('name')
    return value[:200] if isinstance(value, str) and value else identity
