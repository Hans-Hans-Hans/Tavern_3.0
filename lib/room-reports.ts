import { isManagedAccount } from './api';
import { roomContext } from './channel-policy';
import { effectiveRolePermissions } from './roles';
import { getMatrixClient } from './matrix';

export function canReviewRoomReports(roomId: string) {
  if (!isManagedAccount()) return false;
  try {
    const { room, me, policies, unknownPolicy } = roomContext(roomId);
    return !unknownPolicy && policies.length > 0 && room.currentState.hasSufficientPowerLevelFor('redact', room.getMember(me)?.powerLevel || 0)
      && policies.every(policy => effectiveRolePermissions(policy, me, roomId).has('manage_reports'));
  } catch { return false; }
}
export function roomReportLocations(scopeId: string) {
  const client = getMatrixClient(), scope = client?.getRoom(scopeId);
  if (!client || !scope || scope.getMyMembership() !== 'join') return [];
  const result: { id: string; name: string }[] = canReviewRoomReports(scopeId) ? [{ id: scopeId, name: scope.name }] : [];
  if (scope.isSpaceRoom()) for (const event of scope.currentState.getStateEvents('m.space.child').slice(0, 1000)) {
    const identity = event.getStateKey(), room = identity ? client.getRoom(identity) : null, parent = room?.currentState.getStateEvents('m.space.parent', scopeId)?.getContent();
    if (identity && event.getContent().via?.length && parent?.canonical && parent?.via?.length && canReviewRoomReports(identity)) result.push({ id: identity, name: room!.name });
  }
  return result;
}
