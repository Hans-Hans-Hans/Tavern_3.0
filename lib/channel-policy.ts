import { getMatrixClient } from './matrix';
import { effectiveRolePermissions, memberRoleRank, readRolePolicy, type RolePolicy, type RolePermission } from './roles';

export const channelPolicyEvent = 'io.tavern.channel';
export const timeoutEvent = 'io.tavern.timeout';
export const temporaryBanEvent = 'io.tavern.tempban';
export const channelKinds = { text: 'Text', voice: 'Voice', video: 'Video', forum: 'Forum', announcement: 'Announcement', rules: 'Rules', media: 'Media', 'read-only': 'Read only' } as const;
export type ChannelKind = keyof typeof channelKinds;
export type ChannelPolicy = { kind: ChannelKind; slowModeSeconds: number; archived: boolean };

export function normalizeChannelPolicy(value: any): ChannelPolicy {
  return { kind: value && Object.hasOwn(channelKinds, value.kind) ? value.kind : 'text', slowModeSeconds: Number.isInteger(value?.slowModeSeconds) && value.slowModeSeconds >= 0 && value.slowModeSeconds <= 21600 ? value.slowModeSeconds : 0, archived: value?.archived === true };
}
export function readChannelPolicy(roomId: string) { return normalizeChannelPolicy(getMatrixClient()?.getRoom(roomId)?.currentState.getStateEvents(channelPolicyEvent, '')?.getContent()); }
export function roomContext(roomId: string) {
  const client = getMatrixClient(), room = client?.getRoom(roomId), me = client?.getUserId();
  if (!client || !room || !me || room.getMyMembership() !== 'join') throw new Error('Join this conversation first.');
  const policies: RolePolicy[] = [], own = readRolePolicy(roomId);
  if (own) policies.push(own);
  let unknownPolicy = false;
  if (!own) for (const event of room.currentState.getStateEvents('m.space.parent')) {
    if (!event.getContent().canonical || !event.getContent().via?.length) continue;
    const parentId = event.getStateKey(), parent = parentId ? client.getRoom(parentId) : null;
    if (!parent) { unknownPolicy = true; continue; }
    const policy = readRolePolicy(parent.roomId);
    if (policy && parent.currentState.getStateEvents('m.space.child', roomId)?.getContent().via?.length) policies.push(policy);
  }
  return { client, room, me, policies, unknownPolicy };
}
export function canEditChannelPolicy(roomId: string) {
  try { const { room, me, policies, unknownPolicy } = roomContext(roomId); return !unknownPolicy && room.currentState.maySendStateEvent(channelPolicyEvent, me) && policies.every(p => effectiveRolePermissions(p, me, roomId).has('manage_channels')); } catch { return false; }
}
export async function saveChannelPolicy(roomId: string, value: ChannelPolicy) {
  const { client } = roomContext(roomId);
  if (!canEditChannelPolicy(roomId)) throw new Error('You do not have permission to change channel restrictions.');
  if (!Object.hasOwn(channelKinds, value.kind) || !Number.isInteger(value.slowModeSeconds) || value.slowModeSeconds < 0 || value.slowModeSeconds > 21600) throw new Error('Choose a channel kind and slow mode between 0 and 21600 seconds.');
  let existing: any = {};
  try { existing = await client.getStateEvent(roomId, channelPolicyEvent as any, ''); } catch (error) { if ((error as any).errcode !== 'M_NOT_FOUND') throw error; }
  await client.sendStateEvent(roomId, channelPolicyEvent as any, { ...existing, version: 1, ...normalizeChannelPolicy(value) }, '');
}
export function memberTimeout(roomId: string, userId: string): { until: number; reason: string } {
  const value = getMatrixClient()?.getRoom(roomId)?.currentState.getStateEvents(timeoutEvent, userId)?.getContent();
  return { until: Number.isSafeInteger(value?.until) ? value!.until : 0, reason: typeof value?.reason === 'string' ? value.reason.slice(0, 500) : '' };
}
export function canModerateMember(roomId: string, userId: string, operation: 'timeout' | 'kick' | 'ban') {
  try {
    const { room, me, policies, unknownPolicy } = roomContext(roomId), actor = room.getMember(me), target = room.getMember(userId);
    if (unknownPolicy || !target || userId === me || (actor?.powerLevel || 0) <= target.powerLevel) return false;
    const native = operation === 'timeout' ? 'kick' : operation;
    return room.currentState.hasSufficientPowerLevelFor(native, actor?.powerLevel || 0)
      && (operation !== 'timeout' || room.currentState.maySendStateEvent(timeoutEvent, me))
      && policies.every(p => effectiveRolePermissions(p, me, roomId).has(operation as RolePermission) && memberRoleRank(p, me) > memberRoleRank(p, userId));
  } catch { return false; }
}
export async function timeoutMember(roomId: string, userId: string, seconds: number, reason = '') {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 28 * 86400 || reason.length > 500) throw new Error('Choose a timeout of up to 28 days and a reason of up to 500 characters.');
  const { client } = roomContext(roomId);
  if (!canModerateMember(roomId, userId, 'timeout')) throw new Error('You cannot restrict this member. Check your role and their position.');
  await client.sendStateEvent(roomId, timeoutEvent as any, { until: seconds ? Date.now() + seconds * 1000 : 0, reason: reason.trim() }, userId);
}
export async function moderateMember(roomId: string, userId: string, operation: 'kick' | 'ban' | 'unban', reason = '') {
  const { client } = roomContext(roomId);
  if (!canModerateMember(roomId, userId, operation === 'unban' ? 'ban' : operation)) throw new Error('You do not have permission to moderate this member.');
  if (operation === 'kick') await client.kick(roomId, userId, reason);
  else if (operation === 'ban') await client.ban(roomId, userId, reason);
  else await client.unban(roomId, userId);
}
export function postingRestriction(roomId: string): string {
  try {
    const { room, me, client, policies } = roomContext(roomId), policy = readChannelPolicy(roomId);
    const parents = room.currentState.getStateEvents('m.space.parent').filter(event => {
      const parentId = event.getStateKey(), parent = parentId && client.getRoom(parentId);
      return event.getContent().canonical && event.getContent().via?.length && parent && readRolePolicy(parentId!) && parent.currentState.getStateEvents('m.space.child', roomId)?.getContent().via?.length;
    }).map(event => client.getRoom(event.getStateKey()!)!);
    for (const scope of [room, ...parents]) {
      const restriction = scope.currentState.getStateEvents(temporaryBanEvent, me)?.getContent();
      if (!restriction) continue;
      if (restriction.version !== 1 || !Number.isSafeInteger(restriction.until) || restriction.until < 0) return 'A temporary ban is active. Ask a moderator to check its expiry.';
      if (restriction.until > Date.now()) return 'You are temporarily banned ' + (scope.roomId === roomId ? 'from this conversation' : 'from this channel’s server') + ' until ' + new Date(restriction.until).toLocaleString() + '.';
    }
    if (policy.archived) return 'This channel is archived. An authorized member can restore it in channel settings.';
    const until = Math.max(memberTimeout(roomId, me).until, ...room.currentState.getStateEvents('m.space.parent').filter(e => e.getContent().canonical).map(e => memberTimeout(e.getStateKey() || '', me).until));
    if (until > Date.now()) return 'You are timed out until ' + new Date(until).toLocaleString() + '.';
    if (['announcement', 'rules', 'read-only'].includes(policy.kind)) {
      const power = room.currentState.getStateEvents('m.room.power_levels', '')?.getContent() || {};
      const moderator = (room.getMember(me)?.powerLevel || 0) >= (power.redact ?? 50) && policies.every(p => effectiveRolePermissions(p, me, roomId).has('manage_messages'));
      if (!moderator) return 'Only authorized moderators can post in this channel.';
    }
    return '';
  } catch { return ''; }
}
