"""Current Matrix authority for SFU admission; never trust browser role metadata."""
import time
from types import SimpleNamespace
from urllib.parse import quote

try:
    from .server import APIError
    from .room_authority import content, power, room_authority
    from .server_eligibility import account_status, require_room_eligibility
    from .call_audio import audio_snapshot, enabled as audio_enabled
except ImportError:
    from server import APIError
    from room_authority import content, power, room_authority
    from server_eligibility import account_status, require_room_eligibility
    from call_audio import audio_snapshot, enabled as audio_enabled

CALL_MEMBER = 'org.matrix.msc3401.call.member'


async def call_authority(service, session, identity):
    if getattr(service, 'room_removals', None):
        service.room_removals.deny_calls(identity)
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
    authority.audio = await audio_snapshot(service, identity, actor, authority.state, model=authority.model)
    if not authority.audio.publication['joined']:
        raise APIError(403, 'Join every governing server before joining this conference.', 'CALL_ACCESS_DENIED')
    if not audio_enabled() and (any(authority.audio.effective[key] for key in ('muted', 'deafened'))
            or not all(authority.audio.publication[key] for key in ('speak', 'video', 'screen_share'))):
        raise APIError(403, 'Saved conference restrictions require configured SFU media permission support.', 'CALL_ACCESS_DENIED')
    await require_room_eligibility(service, session, identity, authority.state)
    account = account_status(service, actor)
    # Eligibility may perform several remote reads. Do not publish a media grant
    # from an audio snapshot captured before those waits.
    latest_audio = await audio_snapshot(service, identity, actor, model=authority.model)
    if latest_audio.revision != authority.audio.revision:
        raise APIError(403, 'Audio restrictions changed while checking this call. Rejoin the call.', 'CALL_ACCESS_DENIED')
    # Preserve the mandatory native availability ceiling after the final audio
    # state reads. A suspended native token can still answer whoami correctly.
    native = await service.matrix('GET', '/_synapse/admin/v2/users/' + quote(actor, safe=''), token=await service.service_token())
    if (native.get('name') != actor or not model.ServerEligibilityPolicy.native_available(SimpleNamespace(
            is_deactivated=native.get('deactivated'), is_guest=native.get('is_guest'),
            locked=native.get('locked'), suspended=native.get('suspended')))):
        raise APIError(403, 'This account is not available for conference participation.', 'CALL_ACCESS_DENIED')
    final_account = account_status(service, actor)
    if final_account != account or not final_account['available']:
        raise APIError(403, 'Account security changed while checking conference access.', 'CALL_ACCESS_DENIED')
    authority.audio = latest_audio
    return authority
