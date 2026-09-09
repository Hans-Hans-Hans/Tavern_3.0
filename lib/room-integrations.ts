import { isManagedAccount } from './api';
import { memberStateEvent } from './member-state';
import { getMatrixClient } from './matrix';
import { nativeMemberPower, readRolePolicy, effectiveRolePermissions, rolesEvent } from './roles';
import { temporaryBanEvent } from './channel-policy';

function banned(room: any, user: string) {
  const value = memberStateEvent(room, temporaryBanEvent, user)?.getContent();
  return !!value && (value.version !== 1 || !Number.isSafeInteger(value.until) || value.until < 0 || value.until > Date.now());
}

export function canManageRoomWebhooks(roomId: string) {
  if (!isManagedAccount()) return false;
  try {
    const client = getMatrixClient(), room = client?.getRoom(roomId), me = client?.getUserId();
    if (!client || !me || !room || room.getMyMembership() !== 'join' || room.isSpaceRoom() || room.currentState.getStateEvents('m.room.encryption', '')?.getContent().algorithm !== 'm.megolm.v1.aes-sha2') return false;
    const threshold = room.currentState.getStateEvents('m.room.power_levels', '')?.getContent().state_default ?? 50;
    if (!Number.isSafeInteger(threshold) || nativeMemberPower(room, me) < threshold || banned(room, me)) return false;
    const parents = room.currentState.getStateEvents('m.space.parent').filter(event => event.getContent().canonical && event.getContent().via?.length);
    if (parents.length > 32) return false;
    let managed = false;
    for (const event of parents) {
      const id = event.getStateKey(), parent = id ? client.getRoom(id) : null;
      if (!parent) return false;
      if (!parent.currentState.getStateEvents('m.space.child', roomId)?.getContent().via?.length || !parent.currentState.getStateEvents(rolesEvent, '')) continue;
      managed = true;
      const policy = readRolePolicy(parent.roomId);
      if (!policy || parent.getMyMembership() !== 'join' || banned(parent, me) || !effectiveRolePermissions(policy, me, roomId).has('manage_webhooks')) return false;
    }
    return managed;
  } catch { return false; }
}
export function roomWebhookLocations(scopeId: string) {
  const client = getMatrixClient(), scope = client?.getRoom(scopeId);
  if (!client || !scope || scope.getMyMembership() !== 'join') return [];
  if (!scope.isSpaceRoom()) return canManageRoomWebhooks(scopeId) ? [{ id: scopeId, name: scope.name }] : [];
  return scope.currentState.getStateEvents('m.space.child').slice(0, 1000).flatMap(event => {
    const id = event.getStateKey(), room = id ? client.getRoom(id) : null, parent = room?.currentState.getStateEvents('m.space.parent', scopeId)?.getContent();
    return id && room && event.getContent().via?.length && parent?.canonical && parent.via?.length && canManageRoomWebhooks(id) ? [{ id, name: room.name }] : [];
  });
}
