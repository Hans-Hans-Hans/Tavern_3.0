import { getMatrixClient } from './matrix';
import { memberStateEvent, memberStateKey } from './member-state';
import { effectiveRolePermissions, memberRoleRank, nativeMemberPower, parseRolePolicy, rolesEvent } from './roles';

export const serverNicknameEvent = 'io.tavern.server.nickname';
export type ServerNickname = { name: string | null; eventId: string | null; actor: string | null };
const content = (room: any, type: string, key = '') => room?.currentState.getStateEvents(type, key)?.getContent() || {};
const validName = (name: unknown): name is string => typeof name === 'string' && name.length >= 1 && name.length <= 60 && name === name.trim() && !/[\u0000-\u001f\u007f]/.test(name);
function nickname(event: any): ServerNickname {
  const value = event?.getContent() || {};
  return { name: value.version === 1 && validName(value.name) ? value.name : null, eventId: event?.getId() || null, actor: event?.getSender() || null };
}
export function readServerNickname(serverId: string, userId: string): ServerNickname {
  return nickname(memberStateEvent(getMatrixClient()?.getRoom(serverId), serverNicknameEvent, userId));
}
export function serverNicknameForRoom(roomId: string, userId: string, serverId?: string): string | null {
  const client = getMatrixClient(), room = client?.getRoom(roomId), scope = serverId || (room?.isSpaceRoom?.() ? roomId : ''), server = scope ? client?.getRoom(scope) : null;
  if (!server?.isSpaceRoom?.() || server.getMyMembership() !== 'join' || !parseRolePolicy(content(server, rolesEvent)) || content(server, 'm.room.member', userId).membership !== 'join') return null;
  if (roomId !== scope) {
    const parent = content(room, 'm.space.parent', scope), child = content(server, 'm.space.child', roomId);
    if (!parent.canonical || !parent.via?.length || !child.via?.length) return null;
  }
  return readServerNickname(scope, userId).name;
}
function permitted(room: any, actor: string, target: string): boolean {
  const create = content(room, 'm.room.create'), policy = parseRolePolicy(content(room, rolesEvent));
  if (actor === target || !/^@[^\s:]+:[^\s]+$/.test(target) || target.length > 255 || create.type !== 'm.space' || create['m.federate'] !== false || !policy) return false;
  if ([actor, target].some(user => content(room, 'm.room.member', user).membership !== 'join')) return false;
  const powers = content(room, 'm.room.power_levels'), minimum = powers.events?.[serverNicknameEvent] ?? powers.state_default ?? 50;
  if (!Number.isSafeInteger(minimum) || nativeMemberPower(room, actor) < minimum || nativeMemberPower(room, actor) <= nativeMemberPower(room, target)) return false;
  const ban = memberStateEvent(room, 'io.tavern.tempban', actor), timeout = memberStateEvent(room, 'io.tavern.timeout', actor), now = Date.now();
  if (ban) { const value = ban.getContent(); if (value.version !== 1 || !Number.isSafeInteger(value.until) || value.until < 0 || value.until > now) return false; }
  if (timeout) { const until = timeout.getContent().until; if (!Number.isSafeInteger(until) || until > now) return false; }
  return effectiveRolePermissions(policy, actor).has('manage_nicknames') && memberRoleRank(policy, target) < memberRoleRank(policy, actor);
}
export function canManageServerNickname(serverId: string, userId: string): boolean {
  try { const client = getMatrixClient(), actor = client?.getUserId(), room = client?.getRoom(serverId); return !!(actor && room?.isSpaceRoom() && room.getMyMembership() === 'join' && permitted(room, actor, userId)); } catch { return false; }
}
async function checkedNickname(serverId: string, userId: string) {
  const client = getMatrixClient(), actor = client?.getUserId();
  if (!client || !actor || !canManageServerNickname(serverId, userId)) throw new Error('You can manage nicknames only for current server members below your authority.');
  const events = await client.roomState(serverId);
  if (!Array.isArray(events) || events.length > 50000) throw new Error('The server state could not be safely checked.');
  const state = new Map<string, any>();
  for (const event of events) {
    if (!event || typeof event.type !== 'string' || typeof event.state_key !== 'string' || !event.content || typeof event.content !== 'object' || Array.isArray(event.content)) throw new Error('The server state could not be safely checked.');
    const key = event.type + '\0' + event.state_key;
    if (state.has(key)) throw new Error('The server returned ambiguous state. Reload and retry.');
    state.set(key, { getContent: () => event.content, getSender: () => event.sender, getId: () => event.event_id });
  }
  const fresh = { currentState: { getStateEvents: (type: string, key = '') => state.get(type + '\0' + key) } };
  if (client !== getMatrixClient() || client.getUserId() !== actor || !canManageServerNickname(serverId, userId) || !permitted(fresh, actor, userId)) throw new Error('Your account, membership, or authority changed. Reopen this member’s nickname settings.');
  const event = memberStateEvent(fresh, serverNicknameEvent, userId);
  if (event && (typeof event.getId() !== 'string' || !event.getId())) throw new Error('The current nickname revision is unavailable. Reload and retry.');
  return { client, actor, current: nickname(event) };
}
export async function loadServerNickname(serverId: string, userId: string): Promise<ServerNickname> { return (await checkedNickname(serverId, userId)).current; }
export async function saveServerNickname(serverId: string, userId: string, name: string | null, previousEventId: string | null): Promise<ServerNickname> {
  const next = name === null ? null : name.trim();
  if (next !== null && !validName(next)) throw new Error('Enter a nickname of 1–60 characters without control characters.');
  const { client, actor, current } = await checkedNickname(serverId, userId);
  if (current.eventId !== previousEventId) throw new Error('This nickname changed elsewhere. Your draft is preserved. Reload the current nickname before saving.');
  try {
    const result = await client.sendStateEvent(serverId, serverNicknameEvent as any, { version: 1, name: next, 'io.tavern.previous_event': current.eventId }, memberStateKey(userId));
    return { name: next, eventId: result.event_id, actor };
  } catch (error) {
    if ((error as any).errcode === 'M_FORBIDDEN') throw new Error('The server rejected this change. Permissions, membership, or the nickname may have changed. Your draft is preserved; reload before retrying.');
    throw error;
  }
}
