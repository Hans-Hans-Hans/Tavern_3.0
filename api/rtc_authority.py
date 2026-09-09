"""Current Matrix authority for SFU admission; never trust browser role metadata."""
import time
from types import SimpleNamespace

try:
    from .server import APIError
    from .room_authority import content, power, room_authority
    from .server_eligibility import require_room_eligibility
except ImportError:
    from server import APIError
    from room_authority import content, power, room_authority
    from server_eligibility import require_room_eligibility

CALL_MEMBER = 'org.matrix.msc3401.call.member'


async def call_authority(service, session, identity):
    authority = await room_authority(service, session, identity)
    current, actor, model = authority.state, authority.actor, authority.model
    creation = content(current, 'm.room.create')
    if (creation.get('m.federate', True) is not False or creation.get('type') in ('m.space', 'io.tavern.private_thread')
            or 'io.tavern.private_thread' in creation
            or content(current, 'm.room.encryption').get('algorithm') != 'm.megolm.v1.aes-sha2'
            or ('m.room.tombstone', '') in current):
        raise APIError(403, 'This room is not available for a Tavern conference.', 'CALL_ACCESS_DENIED')
    # The embedded driver requires this native membership state permission even
    # when its SFU handshake uses the newer MatrixRTC token protocol.
    powers = content(current, 'm.room.power_levels')
    events = powers.get('events', {})
    if not isinstance(events, dict):
        raise APIError(403, 'The native conference permissions are invalid.', 'CALL_ACCESS_DENIED')
    threshold = events.get(CALL_MEMBER, powers.get('state_default', 50))
    if type(threshold) is not int or power(current, actor) < threshold:
        raise APIError(403, 'The native room permissions do not allow this conference.', 'CALL_ACCESS_DENIED')
    for _, policy, parent in authority.policies:
        if (content(parent, 'm.room.member', actor).get('membership') != 'join'
                or 'join_calls' not in model.permissions(policy, actor, identity)):
            raise APIError(403, 'Your current server or channel role does not allow calls.', 'CALL_ACCESS_DENIED')
    scopes = [current] + [parent for _, _, parent in authority.policies]
    now = int(time.time() * 1000)
    if any(model.temporary_ban_active(scope, actor, now) for scope in scopes):
        raise APIError(403, 'Calls are restricted for this account in this room.', 'CALL_ACCESS_DENIED')
    # Reuse the deployed validator for channel schema, archival and inherited
    # timeouts. A nonempty synthetic membership exercises only its admission
    # branch; it never posts an event or reserves a message cooldown.
    probe = SimpleNamespace(type=CALL_MEMBER, sender=actor, room_id=identity, state_key=actor,
                            content={'application': 'm.call'}, event_id='')
    policy = model.ChannelPolicy(None, model.permissions, model.rank)
    if not await policy.check(probe, current, authority.policies):
        raise APIError(403, 'This channel is archived or calls are currently restricted.', 'CALL_ACCESS_DENIED')
    await require_room_eligibility(service, session, identity, authority.state)
    return authority
