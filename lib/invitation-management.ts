import { getMatrixClient } from './matrix';
import { canInviteToRoom } from './interactions';
import { effectiveRolePermissions, nativeMemberPower, readRolePolicy, rolesEvent } from './roles';

export function canNameInvitation(roomId: string): boolean {
  try {
    const client = getMatrixClient(), room = client?.getRoom(roomId), actor = client?.getUserId();
    if (!room?.isSpaceRoom() || !actor || !canInviteToRoom(roomId)) return false;
    const creation = room.currentState.getStateEvents('m.room.create', '');
    if (creation?.getContent()['m.federate'] !== false) return false;
    const minimum = room.currentState.getStateEvents('m.room.power_levels', '')?.getContent().state_default ?? 50;
    if (!Number.isSafeInteger(minimum) || nativeMemberPower(room, actor) < minimum) return false;
    const raw = room.currentState.getStateEvents(rolesEvent, ''), policy = readRolePolicy(roomId);
    return raw ? !!policy && effectiveRolePermissions(policy, actor, roomId).has('manage_server') : creation?.getSender() === actor;
  } catch { return false; }
}
