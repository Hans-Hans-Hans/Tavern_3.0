import { getMatrixClient } from './matrix';
import { memberStateEvent } from './member-state';
import { effectiveRolePermissions, memberRoleRank, nativeMemberPower, parseRolePolicy, resolveRoomCategory, type RolePermission } from './roles';

export const privateThreadType = 'io.tavern.private_thread';
export const privateThreadSettingsEvent = privateThreadType + '.settings';
export const privateArchiveIntervals = [0, 3600, 86400, 259200, 604800] as const;
export type PrivateThreadBinding = { version: 1; source_room_id: string; source_event_id: string };
export type PrivateThreadSettings = { version: 1; title: string; archived: boolean; autoArchiveSeconds: number; eventId: string | null; activityStartedAt: number };
const content = (room: any, type: string, key = '') => room?.currentState.getStateEvents(type, key)?.getContent() || {};
const id = (value: unknown, prefix: string): value is string => typeof value === 'string' && value.startsWith(prefix) && value.length >= 2 && value.length <= 1024 && !/[\s\u0000-\u001f\u007f]/.test(value);

export function privateThreadBinding(room: any): PrivateThreadBinding | null {
  const creation = content(room, 'm.room.create'), value = creation[privateThreadType];
  return creation.type === privateThreadType && creation['m.federate'] === false && value?.version === 1 && Object.keys(value).sort().join(',') === 'source_event_id,source_room_id,version' && id(value.source_room_id, '!') && (value.source_event_id === '' || id(value.source_event_id, '$')) ? value : null;
}
export function readPrivateThreadSettings(room: any): PrivateThreadSettings {
  const event = room?.currentState.getStateEvents(privateThreadSettingsEvent, ''), value = event?.getContent();
  return { version: 1, title: typeof value?.title === 'string' ? value.title.slice(0, 120) : room?.name || 'Private discussion', archived: value?.archived === true, autoArchiveSeconds: privateArchiveIntervals.includes(value?.autoArchiveSeconds) ? value.autoArchiveSeconds : 0, eventId: event?.getId() || null, activityStartedAt: Number.isSafeInteger(value?.activityStartedAt) ? value.activityStartedAt : 0 };
}
export function privateThreadsForSource(sourceRoomId: string) {
  return (getMatrixClient()?.getRooms() || []).filter(room => ['join', 'invite'].includes(room.getMyMembership()) && privateThreadBinding(room)?.source_room_id === sourceRoomId).map(room => ({ roomId: room.roomId, membership: room.getMyMembership(), ...readPrivateThreadSettings(room) })).sort((a, b) => a.title.localeCompare(b.title));
}
function eligible(rooms: any[], user: string) {
  return rooms.every(room => {
    if (content(room, 'm.room.member', user).membership !== 'join') return false;
    const ban = memberStateEvent(room, 'io.tavern.tempban', user), timeout = memberStateEvent(room, 'io.tavern.timeout', user), now = Date.now();
    if (ban) { const value = ban.getContent(); if (value.version !== 1 || !Number.isSafeInteger(value.until) || value.until < 0 || value.until > now) return false; }
    return !timeout || Number.isSafeInteger(timeout.getContent().until) && timeout.getContent().until <= now;
  });
}
function sourceContext(sourceRoomId: string, lookup: (id: string) => any, actor: string) {
  const room = lookup(sourceRoomId), creation = content(room, 'm.room.create');
  if (!room || creation['m.federate'] !== false || ['m.space', privateThreadType].includes(creation.type) || content(room, 'm.room.encryption').algorithm !== 'm.megolm.v1.aes-sha2') throw new Error('Private discussions require a managed encrypted source channel.');
  const parents = room.currentState.getStateEvents('m.space.parent').filter((event: any) => event.getContent().canonical && event.getContent().via?.length);
  if (!parents.length || parents.length > 10) throw new Error('The source server policy is unavailable.');
  const servers = parents.map((event: any) => lookup(event.getStateKey()));
  const policies = servers.map((server: any) => {
    const creation = content(server, 'm.room.create'), policy = parseRolePolicy(content(server, 'io.tavern.roles'));
    if (!server || creation.type !== 'm.space' || creation['m.federate'] !== false || !policy || !content(server, 'm.space.child', sourceRoomId).via?.length) throw new Error('The source server policy is unavailable.');
    return { policy, category: resolveRoomCategory(content(server, 'io.tavern.server.layout'), sourceRoomId) };
  });
  const rooms = [room, ...servers];
  if (!eligible(rooms, actor)) throw new Error('Your current source membership or restrictions prevent this action.');
  return { room, rooms, policies, grants: (permission: RolePermission) => policies.every(({ policy, category }: any) => effectiveRolePermissions(policy, actor, sourceRoomId, category).has(permission)) };
}
function native(room: any, actor: string, operation: string, kind?: string) {
  const powers = content(room, 'm.room.power_levels'), threshold = operation === 'send' ? powers.events?.[kind!] ?? powers.events_default ?? 0 : powers[operation] ?? (operation === 'invite' ? 0 : 50);
  return Number.isSafeInteger(threshold) && nativeMemberPower(room, actor) >= threshold;
}
function nativeState(room: any, actor: string, kind: string) { const powers = content(room, 'm.room.power_levels'), threshold = powers.events?.[kind] ?? powers.state_default ?? 50; return Number.isSafeInteger(threshold) && nativeMemberPower(room, actor) >= threshold; }
function canPost(context: ReturnType<typeof sourceContext>, actor: string) {
  const channel = content(context.room, 'io.tavern.channel');
  return context.grants('send_messages') && native(context.room, actor, 'send', 'm.room.encrypted') && native(context.room, actor, 'send', 'm.room.message') && !channel.archived && (!['read-only', 'rules', 'announcement'].includes(channel.kind) || context.grants('manage_messages') && native(context.room, actor, 'redact'));
}
export function canCreatePrivateThread(sourceRoomId: string) {
  try { const client = getMatrixClient(), actor = client?.getUserId(); if (!client || !actor) return false; const context = sourceContext(sourceRoomId, value => client.getRoom(value), actor); return context.grants('create_private_threads') && canPost(context, actor); } catch { return false; }
}
export function privateThreadMembers(roomId: string) {
  const room = getMatrixClient()?.getRoom(roomId);
  return (room?.getMembers() || []).filter(member => ['join', 'invite'].includes(member.membership || '')).map(member => ({ userId: member.userId, name: member.name, membership: member.membership }));
}
export function privateThreadCandidates(sourceRoomId: string, roomId?: string) {
  const client = getMatrixClient(), me = client?.getUserId(), present = new Set(roomId ? privateThreadMembers(roomId).map(member => member.userId) : []);
  return (client?.getRoom(sourceRoomId)?.getJoinedMembers() || []).filter(member => member.userId !== me && !present.has(member.userId)).map(member => ({ userId: member.userId, name: member.name }));
}
function roomFromState(roomId: string, events: any[]) {
  if (!Array.isArray(events) || events.length > 50000) throw new Error('The room state could not be safely checked.');
  const entries = events.map(event => {
    if (!event || typeof event.type !== 'string' || typeof event.state_key !== 'string' || !event.content || typeof event.content !== 'object' || Array.isArray(event.content)) throw new Error('The room returned invalid state.');
    return { getType: () => event.type, getStateKey: () => event.state_key, getContent: () => event.content, getSender: () => event.sender, getId: () => event.event_id };
  });
  if (new Set(entries.map(event => event.getType() + '\0' + event.getStateKey())).size !== entries.length) throw new Error('The room returned ambiguous state.');
  return { roomId, currentState: { getStateEvents: (kind: string, key?: string) => key === undefined ? entries.filter(event => event.getType() === kind) : entries.find(event => event.getType() === kind && event.getStateKey() === key) } };
}
async function freshSource(sourceRoomId: string) {
  const client = getMatrixClient(), actor = client?.getUserId(); if (!client || !actor) throw new Error('Sign in first.');
  const source = roomFromState(sourceRoomId, await client.roomState(sourceRoomId)), rooms = new Map([[sourceRoomId, source]]);
  const parents = (source.currentState.getStateEvents('m.space.parent') as any[]).filter(event => event.getContent().canonical && event.getContent().via?.length);
  if (!parents.length || parents.length > 10) throw new Error('The source server policy is unavailable.');
  for (const parent of parents) { const id = parent.getStateKey(); rooms.set(id, roomFromState(id, await client.roomState(id))); }
  if (client !== getMatrixClient() || client.getUserId() !== actor) throw new Error('Your session changed.');
  return { client, actor, context: sourceContext(sourceRoomId, value => rooms.get(value), actor) };
}
function settingsContent(value: Pick<PrivateThreadSettings, 'title' | 'archived' | 'autoArchiveSeconds'>, previous: string | null, reopen = false) {
  const title = value.title.trim();
  if (!title || title.length > 120 || /[\u0000-\u001f\u007f]/.test(title) || typeof value.archived !== 'boolean' || !privateArchiveIntervals.includes(value.autoArchiveSeconds as any)) throw new Error('Choose a title of 1–120 characters and a supported archive interval.');
  return { version: 1, title, archived: value.archived, autoArchiveSeconds: value.autoArchiveSeconds, 'io.tavern.previous_event': previous, reopen };
}
export async function createPrivateThread(sourceRoomId: string, title: string, invite: string[], sourceEventId = '', autoArchiveSeconds = 0) {
  if (!id(sourceRoomId, '!') || sourceEventId && !id(sourceEventId, '$') || invite.length > 50 || new Set(invite).size !== invite.length || invite.some(user => !id(user, '@'))) throw new Error('Choose a source and up to 50 distinct members.');
  const settings = settingsContent({ title, archived: false, autoArchiveSeconds }, null);
  const { client, actor, context } = await freshSource(sourceRoomId);
  if (!context.grants('create_private_threads') || !canPost(context, actor) || invite.some(user => user === actor || !eligible(context.rooms, user)) || invite.length > 0 && (!context.grants('invite') || !native(context.room, actor, 'invite'))) throw new Error('Your current permissions or selected source members changed.');
  if (sourceEventId) { const event = await client.fetchRoomEvent(sourceRoomId, sourceEventId); if (event.room_id !== sourceRoomId || !['m.room.message', 'm.room.encrypted'].includes(event.type!)) throw new Error('The source message is unavailable in this channel.'); }
  if (client !== getMatrixClient() || client.getUserId() !== actor) throw new Error('Your session changed.');
  const result = await client.createRoom({ visibility: 'private', preset: 'private_chat', name: settings.title, invite,
    creation_content: { type: privateThreadType, 'm.federate': false, [privateThreadType]: { version: 1, source_room_id: sourceRoomId, source_event_id: sourceEventId } },
    initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }, { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } }, { type: privateThreadSettingsEvent, state_key: '', content: settings }],
  } as any);
  return result.room_id;
}
async function freshDiscussion(roomId: string) {
  const client = getMatrixClient(); if (!client) throw new Error('Sign in first.');
  const room = roomFromState(roomId, await client.roomState(roomId)), binding = privateThreadBinding(room);
  if (!binding) throw new Error('This private discussion has invalid source information.');
  const fresh = await freshSource(binding.source_room_id);
  if (fresh.client !== client || content(room, 'm.room.member', fresh.actor).membership !== 'join' || content(room, 'm.room.history_visibility').history_visibility !== 'joined' || content(room, 'm.room.encryption').algorithm !== 'm.megolm.v1.aes-sha2') throw new Error('Join this encrypted private discussion first.');
  return { ...fresh, room, binding };
}
function cachedDiscussion(roomId: string) {
  const client = getMatrixClient(), actor = client?.getUserId(), room = client?.getRoom(roomId), binding = privateThreadBinding(room);
  if (!client || !actor || !binding || room?.getMyMembership() !== 'join' || content(room, 'm.room.history_visibility').history_visibility !== 'joined' || content(room, 'm.room.encryption').algorithm !== 'm.megolm.v1.aes-sha2') throw new Error('Join this encrypted private discussion first.');
  return { client, actor, room, context: sourceContext(binding.source_room_id, id => client.getRoom(id), actor) };
}
export function canInvitePrivateThread(roomId: string) { try { const { room, actor, context } = cachedDiscussion(roomId); return context.grants('invite') && native(context.room, actor, 'invite') && native(room, actor, 'invite'); } catch { return false; } }
export function canModeratePrivateThreadMember(roomId: string, userId: string, operation: 'kick' | 'ban' = 'kick') { try { const { room, actor, context } = cachedDiscussion(roomId); return userId !== actor && context.grants(operation) && [room, ...context.rooms].every(scope => native(scope, actor, operation) && nativeMemberPower(scope, actor) > nativeMemberPower(scope, userId)) && context.policies.every(({ policy }: any) => memberRoleRank(policy, actor) > memberRoleRank(policy, userId)); } catch { return false; } }
export function canPostPrivateThread(roomId: string) { try { const { room, actor, context } = cachedDiscussion(roomId); return canPost(context, actor) && native(room, actor, 'send', 'm.room.encrypted') && !privateThreadArchived(room); } catch { return false; } }
export function privateThreadMessagePermissions(roomId: string, senderId: string) {
  const denied = { send: false, edit: false, delete: false, pin: false, react: false };
  try {
    const { room, actor, context } = cachedDiscussion(roomId), scopes = [room, context.room], archived = privateThreadArchived(room) || content(context.room, 'io.tavern.channel').archived;
    const send = !archived && canPost(context, actor) && native(room, actor, 'send', 'm.room.encrypted');
    return { send, edit: send && actor === senderId,
      delete: scopes.every(scope => native(scope, actor, 'send', 'm.room.redaction')) && (actor === senderId || context.grants('manage_messages') && scopes.every(scope => native(scope, actor, 'redact'))),
      pin: !archived && context.grants('pin_messages') && scopes.every(scope => nativeState(scope, actor, 'm.room.pinned_events')),
      react: !archived && context.grants('add_reactions') && scopes.every(scope => native(scope, actor, 'send', 'm.reaction')) };
  } catch { return denied; }
}
export async function invitePrivateThreadMember(roomId: string, userId: string) {
  const { client, actor, context, room } = await freshDiscussion(roomId);
  if (!id(userId, '@') || userId === actor || !eligible(context.rooms, userId) || !context.grants('invite') || !native(context.room, actor, 'invite') || !native(room, actor, 'invite')) throw new Error('Only eligible current source members can be invited with your permissions.');
  await client.invite(roomId, userId);
}
export async function moderatePrivateThreadMember(roomId: string, userId: string, operation: 'kick' | 'ban') {
  const { client, actor, context, room } = await freshDiscussion(roomId);
  if (!['kick', 'ban'].includes(operation) || !id(userId, '@') || userId === actor || !context.grants(operation) || ![room, ...context.rooms].every(scope => native(scope, actor, operation) && nativeMemberPower(scope, actor) > nativeMemberPower(scope, userId)) || !context.policies.every(({ policy }: any) => memberRoleRank(policy, actor) > memberRoleRank(policy, userId))) throw new Error('Your source and private room authority must both exceed this member’s authority.');
  await client[operation](roomId, userId, 'Private discussion membership updated');
}
export function canEditPrivateThread(roomId: string) {
  try { const client = getMatrixClient(), actor = client?.getUserId(), room = client?.getRoom(roomId), binding = privateThreadBinding(room); if (!client || !actor || !binding || room?.getMyMembership() !== 'join' || !room.currentState.maySendStateEvent(privateThreadSettingsEvent, actor)) return false; const context = sourceContext(binding.source_room_id, id => client.getRoom(id), actor); return room.currentState.getStateEvents('m.room.create', '')?.getSender() === actor ? context.grants('create_private_threads') : context.grants('manage_messages') && native(context.room, actor, 'redact'); } catch { return false; }
}
export async function savePrivateThreadSettings(roomId: string, settings: PrivateThreadSettings, reopen = false) {
  const next = settingsContent(settings, settings.eventId, reopen), { client, actor, context, room } = await freshDiscussion(roomId), current = readPrivateThreadSettings(room);
  if (current.eventId !== settings.eventId) throw new Error('Discussion settings changed elsewhere. Your draft is preserved. Reload before saving.');
  const creator = room.currentState.getStateEvents('m.room.create', '') as any;
  if (!canEditPrivateThread(roomId) || (creator?.getSender() === actor ? !context.grants('create_private_threads') : !context.grants('manage_messages') || !native(context.room, actor, 'redact'))) throw new Error('Your current permissions do not allow changing this discussion.');
  await client.sendStateEvent(roomId, privateThreadSettingsEvent as any, next, '');
}
export async function loadPrivateThreadSettings(roomId: string) { return readPrivateThreadSettings((await freshDiscussion(roomId)).room); }
export function privateThreadArchived(room: any, now = Date.now()) {
  const settings = readPrivateThreadSettings(room), events = room?.getLiveTimeline?.().getEvents() || [];
  const activity = Math.max(settings.activityStartedAt, ...events.filter((event: any) => ['m.room.encrypted', 'm.room.message'].includes(event.getType())).map((event: any) => event.getTs() || 0));
  return settings.archived || !!(settings.autoArchiveSeconds && activity + settings.autoArchiveSeconds * 1000 <= now);
}
export async function sendPrivateThreadMessage(roomId: string, body: string, transactionId: string) {
  if (!body.trim() || body.length > 16000) throw new Error('Enter a message of up to 16,000 characters.');
  const { client, actor, context, room } = await freshDiscussion(roomId);
  if (!canPost(context, actor) || !native(room, actor, 'send', 'm.room.encrypted') || privateThreadArchived(client.getRoom(roomId))) throw new Error('This discussion is archived or your current permissions prevent posting.');
  const mentions = (client.getRoom(roomId)?.getJoinedMembers() || []).filter(member => body.includes(member.userId)).map(member => member.userId);
  await client.sendMessage(roomId, { msgtype: 'm.text', body, 'm.mentions': { user_ids: mentions } } as any, transactionId);
}
