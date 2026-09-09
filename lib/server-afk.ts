import { getMatrixClient } from './matrix';
import { memberStateEvent } from './member-state';
import { canEditConversationState, checkedConversationState } from './channel-administration';
import { effectiveRolePermissions, nativeMemberPower, readRolePolicy } from './roles';

export const serverAfkEvent = 'io.tavern.server.afk';
export const afkTimeouts = [300, 600, 900, 1800, 3600] as const;
export type ServerAfk = { version: 1; channelId: string; timeoutSeconds: number };
export const emptyServerAfk = (): ServerAfk => ({ version: 1, channelId: '', timeoutSeconds: 300 });
export function parseServerAfk(value: any): ServerAfk | null {
  if (!value || value.version !== 1 || Object.keys(value).some(key => !['version', 'channelId', 'timeoutSeconds', 'io.tavern.previous_event'].includes(key)) || typeof value.channelId !== 'string' || value.channelId && (!value.channelId.startsWith('!') || value.channelId.length < 2 || value.channelId.length > 255 || /[\s\x00-\x1f\x7f]/.test(value.channelId)) || !(afkTimeouts as readonly number[]).includes(value.timeoutSeconds)) return null;
  return { version: 1, channelId: value.channelId, timeoutSeconds: value.timeoutSeconds };
}
const content = (room: any, type: string, key = '') => room?.currentState.getStateEvents(type, key)?.getContent() || {};
export function readServerAfk(serverId: string): ServerAfk | null {
  const event = getMatrixClient()?.getRoom(serverId)?.currentState.getStateEvents(serverAfkEvent, '');
  return event ? parseServerAfk(event.getContent()) : emptyServerAfk();
}
function destination(server: any, room: any) {
  const create = content(room, 'm.room.create'), policy = content(room, 'io.tavern.channel'), parent = content(room, 'm.space.parent', server?.roomId);
  return !!(server?.isSpaceRoom() && content(server, 'm.room.create')['m.federate'] === false && room && room.getMyMembership() === 'join'
    && create['m.federate'] === false && !['m.space', 'io.tavern.private_thread'].includes(create.type)
    && content(room, 'm.room.encryption').algorithm === 'm.megolm.v1.aes-sha2' && !Object.keys(content(room, 'm.room.tombstone')).length
    && policy.kind === 'voice' && (policy.archived ?? false) === false && (policy.version ?? 1) === 1
    && parent.canonical === true && parent.via?.length && content(server, 'm.space.child', room.roomId).via?.length);
}
export function afkDestinations(serverId: string) {
  const client = getMatrixClient(), server = client?.getRoom(serverId);
  if (!client || server?.getMyMembership() !== 'join') return [];
  return client.getRooms().filter(room => destination(server, room)).map(room => ({ id: room.roomId, name: room.name }));
}
/** Suggestions must remain callable under native and every current parent policy. */
export function canJoinAfkDestination(roomId: string) {
  try {
    const client = getMatrixClient(), room = client?.getRoom(roomId), me = client?.getUserId();
    if (!client || !room || !me || room.getMyMembership() !== 'join') return false;
    const powers = content(room, 'm.room.power_levels'), required = powers.events?.['org.matrix.msc3401.call.member'] ?? powers.state_default ?? 50;
    if (!Number.isSafeInteger(required) || nativeMemberPower(room, me) < required) return false;
    const parents = room.currentState.getStateEvents('m.space.parent').filter(event => event.getContent().canonical === true && event.getContent().via?.length);
    if (!parents.length || parents.length > 32) return false;
    const scopes = [room];
    for (const event of parents) {
      const parent = client.getRoom(event.getStateKey() || '');
      if (!parent?.isSpaceRoom() || parent.getMyMembership() !== 'join' || !content(parent, 'm.space.child', roomId).via?.length) return false;
      scopes.push(parent);
    }
    const now = Date.now();
    for (const scope of scopes) {
      const timeoutEvent = memberStateEvent(scope, 'io.tavern.timeout', me), timeout = timeoutEvent ? timeoutEvent.getContent().until : 0, ban = memberStateEvent(scope, 'io.tavern.tempban', me)?.getContent();
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > now || ban && (ban.version !== 1 || !Number.isSafeInteger(ban.until) || ban.until < 0 || ban.until > now)) return false;
      const event = scope.currentState.getStateEvents('io.tavern.roles' as any, '');
      if (event) {
        const policy = readRolePolicy(scope.roomId), layout = scope.currentState.getStateEvents('io.tavern.server.layout' as any, '')?.getContent();
        if (!policy || layout && (layout.version !== 1 || !Array.isArray(layout.categories) || !Array.isArray(layout.channels))) return false;
        if (!effectiveRolePermissions(policy, me, roomId).has('join_calls')) return false;
      }
    }
    return true;
  } catch { return false; }
}
export function canManageServerAfk(serverId: string) {
  const room = getMatrixClient()?.getRoom(serverId);
  return !!(room?.isSpaceRoom() && content(room, 'm.room.create')['m.federate'] === false && canEditConversationState(serverId, serverAfkEvent));
}
export async function saveServerAfk(serverId: string, value: ServerAfk, previous: ServerAfk | null) {
  const next = parseServerAfk(value);
  if (!next || !canManageServerAfk(serverId)) throw new Error('Choose valid AFK settings and check your server permissions.');
  const client = await checkedConversationState(serverId, serverAfkEvent), state = await client.roomState(serverId);
  if (!Array.isArray(state) || state.length > 50000) throw new Error('Server settings could not be safely checked.');
  const observed = state.find(event => event.type === serverAfkEvent && event.state_key === '');
  const current = observed ? parseServerAfk(observed.content) : emptyServerAfk();
  if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('AFK settings changed. Reload them before saving.');
  if (next.channelId && !afkDestinations(serverId).some(room => room.id === next.channelId)) throw new Error('Choose an available encrypted voice channel in this server.');
  const checked = await checkedConversationState(serverId, serverAfkEvent);
  if (checked !== client || !canManageServerAfk(serverId)) throw new Error('Your account or server permissions changed.');
  await client.sendStateEvent(serverId, serverAfkEvent as any, { ...next, 'io.tavern.previous_event': observed?.event_id ?? null }, '');
  return next;
}
/** A single unambiguous current server may suggest an AFK destination. */
export function conferenceAfk(roomId: string): (ServerAfk & { serverId: string; destinationName: string }) | null {
  const client = getMatrixClient(), room = client?.getRoom(roomId);
  if (!client || !room || room.getMyMembership() !== 'join' || ['m.space', 'io.tavern.private_thread'].includes(content(room, 'm.room.create').type)) return null;
  const parents = room.currentState.getStateEvents('m.space.parent').filter(event => event.getContent().canonical === true && event.getContent().via?.length);
  if (parents.length !== 1) return null;
  const serverId = parents[0].getStateKey()!, server = client.getRoom(serverId), settings = readServerAfk(serverId);
  const target = settings?.channelId ? client.getRoom(settings.channelId) : null;
  if (!server || server.getMyMembership() !== 'join' || !content(server, 'm.space.child', roomId).via?.length || !settings?.channelId || settings.channelId === roomId || !destination(server, target) || !canJoinAfkDestination(settings.channelId)) return null;
  return { ...settings, serverId, destinationName: target!.name };
}
