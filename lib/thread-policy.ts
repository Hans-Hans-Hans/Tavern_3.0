import { getMatrixClient } from './matrix';
import { roomContext } from './channel-policy';
import { effectiveRolePermissions } from './roles';

export const threadPolicyEvent = 'io.tavern.thread';
export const threadArchiveIntervals = [0, 3600, 86400, 259200, 604800] as const;
export type ThreadPolicy = { version: 1; title: string; tags: string[]; closed: boolean; locked: boolean; archived: boolean; autoArchiveSeconds: number; updatedAt: number; activityStartedAt: number };
export function normalizeThreadPolicy(value: any): ThreadPolicy {
  return { version: 1, title: typeof value?.title === 'string' ? value.title.slice(0, 120) : '', tags: Array.isArray(value?.tags) ? value.tags.filter((tag: unknown) => typeof tag === 'string' && tag.trim()).slice(0, 10).map((tag: string) => tag.trim().slice(0, 32)) : [], closed: value?.closed === true, locked: value?.locked === true, archived: value?.archived === true, autoArchiveSeconds: threadArchiveIntervals.includes(value?.autoArchiveSeconds) ? value.autoArchiveSeconds : 0, updatedAt: Number.isSafeInteger(value?.updatedAt) ? value.updatedAt : 0, activityStartedAt: Number.isSafeInteger(value?.activityStartedAt) ? value.activityStartedAt : 0 };
}
export function readThreadPolicy(roomId: string, rootId: string) { return normalizeThreadPolicy(getMatrixClient()?.getRoom(roomId)?.currentState.getStateEvents(threadPolicyEvent, rootId)?.getContent()); }
export function isThreadModerator(roomId: string) {
  try { const { room, me, policies, unknownPolicy } = roomContext(roomId), power = room.currentState.getStateEvents('m.room.power_levels', '')?.getContent() || {}; return !unknownPolicy && (room.getMember(me)?.powerLevel || 0) >= (power.redact ?? 50) && policies.every(policy => effectiveRolePermissions(policy, me, roomId).has('manage_messages')); } catch { return false; }
}
export function canEditThreadPolicy(roomId: string, rootId: string, authorId?: string) {
  try {
    const { room, me, unknownPolicy } = roomContext(roomId), root = room.findEventById(rootId) || room.getThread(rootId)?.rootEvent;
    if (unknownPolicy || !room.currentState.maySendStateEvent(threadPolicyEvent, me)) return false;
    const moderator = isThreadModerator(roomId);
    return (!readThreadPolicy(roomId, rootId).locked || moderator) && (moderator || (root?.getSender() || authorId) === me);
  } catch { return false; }
}
export async function saveThreadPolicy(roomId: string, rootId: string, value: ThreadPolicy, reopen = false) {
  const { client } = roomContext(roomId);
  const root = await client.fetchRoomEvent(roomId, rootId);
  if (root.room_id && root.room_id !== roomId) throw new Error('This thread belongs to another conversation.');
  if (!canEditThreadPolicy(roomId, rootId, root.sender)) throw new Error('Only this thread’s author or an authorized moderator can change its settings.');
  if (value.title.length > 120 || value.tags.length > 10 || value.tags.some(tag => !tag.trim() || tag.length > 32) || !threadArchiveIntervals.includes(value.autoArchiveSeconds as any)) throw new Error('Use a title of up to 120 characters and up to 10 tags of 32 characters each.');
  let current: any = {};
  try { current = await client.getStateEvent(roomId, threadPolicyEvent as any, rootId); } catch (error) { if ((error as any).errcode !== 'M_NOT_FOUND') throw error; }
  const moderator = isThreadModerator(roomId);
  if ((current.locked || !!current.locked !== value.locked) && !moderator) throw new Error('Only moderators can lock or unlock a thread.');
  await client.sendStateEvent(roomId, threadPolicyEvent as any, { ...normalizeThreadPolicy(value), reopen, updatedAt: Date.now() }, rootId);
}
export function threadReplyRestriction(roomId: string, rootId: string, lastActivity = 0) {
  const value = readThreadPolicy(roomId, rootId);
  if (value.locked) return 'This thread is locked. A moderator can unlock it.';
  if (value.archived) return 'This thread is archived. Its author or a moderator can restore it.';
  if (value.closed) return 'This thread is closed. Its author or a moderator can reopen it.';
  if (value.autoArchiveSeconds) {
    const thread = getMatrixClient()?.getRoom(roomId)?.getThread(rootId);
    const activity = Math.max(lastActivity, thread?.events.at(-1)?.getTs() || 0, value.activityStartedAt);
    if (!activity || activity + value.autoArchiveSeconds * 1000 <= Date.now()) return 'This thread was archived after inactivity. Its author or a moderator can reopen it.';
  }
  return '';
}
export async function enableThreadSettings(roomId: string) {
  const { client, room, me, policies, unknownPolicy } = roomContext(roomId);
  if (unknownPolicy || !room.currentState.maySendStateEvent('m.room.power_levels', me) || policies.some(policy => policy.owner !== me)) throw new Error('The room owner must enable member thread settings.');
  const power = await client.getStateEvent(roomId, 'm.room.power_levels', '');
  await client.sendStateEvent(roomId, 'm.room.power_levels' as any, { ...power, events: { ...power.events, [threadPolicyEvent]: 0 } }, '');
}
