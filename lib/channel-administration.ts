import { getMatrixClient } from './matrix';
import { effectiveRolePermissions, memberRoleRank, nativeMemberPower as nativeLevel, readRolePolicy, resolveRoomCategory, rolesEvent, type RolePolicy } from './roles';

export type ConversationAction = 'kick' | 'ban' | 'unban' | 'moderator' | 'member';
const layoutEvent = 'io.tavern.server.layout';
type Scope = { room: any; policy: RolePolicy | null };
function content(room: any, type: string, key = '') { return room.currentState.getStateEvents(type, key)?.getContent() || {}; }
function threshold(room: any, event: string) {
  const powers = content(room, 'm.room.power_levels');
  const value = event.startsWith('m.') || event.startsWith('org.') ? powers.events?.[event] ?? powers.state_default ?? 50 : powers[event] ?? 50;
  if (!Number.isSafeInteger(value)) throw new Error('Room power levels are invalid.');
  return value;
}
function validLayout(value: any) {
  if (value.version !== 1 || !Array.isArray(value.categories) || value.categories.length > 100 || !Array.isArray(value.channels) || value.channels.length > 1000) return false;
  const categories = new Set<string>(), rooms = new Set<string>();
  for (const category of value.categories) { if (typeof category?.id !== 'string' || !/^[\w-]{1,80}$/.test(category.id) || categories.has(category.id)) return false; categories.add(category.id); }
  for (const channel of value.channels) { if (typeof channel?.id !== 'string' || !channel.id.startsWith('!') || rooms.has(channel.id) || typeof (channel.category ?? '') !== 'string' || channel.category && !categories.has(channel.category)) return false; rooms.add(channel.id); }
  return true;
}
function context(roomId: string) {
  const client = getMatrixClient(), room = client?.getRoom(roomId), me = client?.getUserId();
  if (!client || !room || !me || room.getMyMembership() !== 'join') throw new Error('Join this conversation first.');
  const scopes: Scope[] = [], own = room.currentState.getStateEvents(rolesEvent, '');
  const add = (candidate: any) => {
    const raw = candidate.currentState.getStateEvents(rolesEvent, ''), policy = readRolePolicy(candidate.roomId);
    if (raw && !policy) throw new Error('The server role policy is invalid. Ask its owner to repair it.');
    if (policy && candidate.getMyMembership() !== 'join') throw new Error('Join the parent server before administering this channel.');
    const layout = candidate.currentState.getStateEvents(layoutEvent, '');
    if (policy && layout && !validLayout(layout.getContent())) throw new Error('The server category policy is invalid.');
    scopes.push({ room: candidate, policy });
  };
  if (own) add(room);
  else {
    const parents = room.currentState.getStateEvents('m.space.parent').filter(event => event.getContent().canonical && event.getContent().via?.length);
    if (parents.length > 32) throw new Error('This room has too many parent servers to safely check permissions.');
    for (const event of parents) {
      const parentId = event.getStateKey(), parent = parentId ? client.getRoom(parentId) : null;
      if (!parent) throw new Error('Wait for the parent server to finish syncing.');
      if (content(parent, 'm.space.child', roomId).via?.length) add(parent);
    }
  }
  return { client, room, me, scopes };
}
function permitted(scope: Scope, actor: string, roomId: string, permission: 'manage_server' | 'manage_channels' | 'kick' | 'ban') {
  return !scope.policy || effectiveRolePermissions(scope.policy, actor, roomId, resolveRoomCategory(content(scope.room, layoutEvent), roomId)).has(permission);
}
export function canEditConversationDetails(roomId: string) {
  try { const { room, me, scopes } = context(roomId), level = nativeLevel(room, me); return level >= threshold(room, 'm.room.name') && level >= threshold(room, 'm.room.topic') && scopes.every(scope => permitted(scope, me, roomId, scope.room.roomId === roomId ? 'manage_server' : 'manage_channels')); } catch { return false; }
}
export function canEditNativePermissions(roomId: string) {
  try { const { room, me, scopes } = context(roomId); return nativeLevel(room, me) >= threshold(room, 'm.room.power_levels') && scopes.every(scope => !scope.policy || scope.policy.owner === me); } catch { return false; }
}
export function conversationMemberLevel(roomId: string, userId: string) { try { return nativeLevel(context(roomId).room, userId); } catch { return null; } }
export function canAdministerMember(roomId: string, targetId: string, action: ConversationAction) {
  try {
    if (!['kick', 'ban', 'unban', 'moderator', 'member'].includes(action)) return false;
    const { room, me, scopes } = context(roomId), member = room.getMember(targetId), actor = nativeLevel(room, me), target = nativeLevel(room, targetId);
    if (!member || targetId === me || actor <= target || scopes.some(scope => scope.policy && memberRoleRank(scope.policy, me) <= memberRoleRank(scope.policy, targetId))) return false;
    if (action === 'moderator' || action === 'member') return member.membership === 'join' && canEditNativePermissions(roomId) && actor >= (action === 'moderator' ? 50 : 0) && target !== (action === 'moderator' ? 50 : 0);
    if (action === 'unban' ? member.membership !== 'ban' : !['join', 'invite'].includes(member.membership || '')) return false;
    const permission = action === 'kick' ? 'kick' : 'ban';
    return actor >= threshold(room, permission) && (action !== 'unban' || actor >= threshold(room, 'kick')) && scopes.every(scope => permitted(scope, me, roomId, permission));
  } catch { return false; }
}
function stable(value: any): string { if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'; if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'; return JSON.stringify(value); }
function entries(room: any, actor: string, target?: string, child?: string) {
  return ['m.room.create', 'm.room.power_levels', rolesEvent, layoutEvent, 'm.space.parent', 'm.space.child', 'm.room.member'].flatMap(type => room.currentState.getStateEvents(type).filter((event: any) => type !== 'm.room.member' || [actor, target].includes(event.getStateKey())).filter((event: any) => type !== 'm.space.child' || event.getStateKey() === child).map((event: any) => ({ type, state_key: event.getStateKey(), content: event.getContent(), ...(type === 'm.room.create' ? { sender: event.getSender() } : {}) })));
}
function fingerprint(events: any[]) { return stable(events.sort((a, b) => (a.type + '\0' + a.state_key).localeCompare(b.type + '\0' + b.state_key))); }
async function checkedContext(roomId: string, target?: string) {
  const initial = context(roomId), scopes = [initial.room, ...initial.scopes.map(scope => scope.room)].filter((room, index, rooms) => rooms.indexOf(room) === index);
  const snapshots = scopes.map(room => ({ room, fingerprint: fingerprint(entries(room, initial.me, target, roomId)) }));
  let powers: any = {};
  for (const snapshot of snapshots) {
    const remote = await initial.client.roomState(snapshot.room.roomId);
    if (!Array.isArray(remote) || remote.length > 50000) throw new Error('The room state could not be safely checked.');
    const types = new Set(['m.room.create', 'm.room.power_levels', rolesEvent, layoutEvent, 'm.space.parent', 'm.space.child', 'm.room.member']);
    const selected = remote.filter(event => types.has(event.type) && (event.type !== 'm.room.member' || [initial.me, target].includes(event.state_key)) && (event.type !== 'm.space.child' || event.state_key === roomId)).map(event => ({ type: event.type, state_key: event.state_key, content: event.content, ...(event.type === 'm.room.create' ? { sender: event.sender } : {}) }));
    if (fingerprint(selected) !== snapshot.fingerprint) throw new Error('Permissions or memberships changed while syncing. Reopen this panel and review the action.');
    if (snapshot.room.roomId === roomId) powers = remote.find(event => event.type === 'm.room.power_levels' && event.state_key === '')?.content || {};
  }
  if (getMatrixClient() !== initial.client || initial.client.getUserId() !== initial.me || snapshots.some(snapshot => fingerprint(entries(snapshot.room, initial.me, target, roomId)) !== snapshot.fingerprint)) throw new Error('Your account or room permissions changed. Reopen this panel.');
  return { ...context(roomId), powers };
}
function preserveCreator(room: any, powers: any) {
  if (room.currentState.getStateEvents('m.room.power_levels', '')) return powers;
  const create = room.currentState.getStateEvents('m.room.create', '');
  const creator = create?.getSender();
  return creator && create.getContent().room_version !== '12' ? { ...powers, users: { [creator]: 100, ...powers.users } } : powers;
}
export async function administerMember(roomId: string, target: string, action: ConversationAction, reason: string, expectedLevel: number) {
  if (!canAdministerMember(roomId, target, action)) throw new Error('You cannot perform this action on the selected member.');
  const { client, room, powers } = await checkedContext(roomId, target);
  if (!canAdministerMember(roomId, target, action) || nativeLevel(room, target) !== expectedLevel) throw new Error('This member’s permissions changed. Review the action again.');
  if (action === 'moderator' || action === 'member') {
    const current = preserveCreator(room, powers);
    await client.sendStateEvent(roomId, 'm.room.power_levels' as any, { ...current, users: { ...current.users, [target]: action === 'moderator' ? 50 : 0 } }, '');
  } else if (action === 'kick') await client.kick(roomId, target, reason.trim().slice(0, 200));
  else if (action === 'ban') await client.ban(roomId, target, reason.trim().slice(0, 200));
  else await client.unban(roomId, target);
}
export async function saveConversationDetails(roomId: string, name: string, topic: string) {
  name = name.trim(); if (!name || name.length > 60 || topic.length > 500) throw new Error('Enter a name of up to 60 characters and a topic of up to 500 characters.');
  if (!canEditConversationDetails(roomId)) throw new Error('You cannot edit this conversation.');
  const { client } = await checkedContext(roomId);
  if (!canEditConversationDetails(roomId)) throw new Error('Your conversation permissions changed.');
  await client.sendStateEvent(roomId, 'm.room.name' as any, { name }, '');
  try {
    const next = await checkedContext(roomId);
    if (next.client !== client || !canEditConversationDetails(roomId)) throw new Error('Your permissions changed.');
    await client.sendStateEvent(roomId, 'm.room.topic' as any, { topic }, '');
  } catch { throw new Error('Name saved, but the topic could not be updated. Reopen this panel and retry.'); }
}
export async function saveNativePermissions(roomId: string, changes: { post: number; invite: number; pin: number; conference: number }) {
  if (!canEditNativePermissions(roomId) || [changes.post, changes.invite, changes.pin, changes.conference].some(value => !Number.isSafeInteger(value))) throw new Error('You cannot change these native room permissions.');
  const { client, room, me, powers } = await checkedContext(roomId), level = nativeLevel(room, me);
  if (!canEditNativePermissions(roomId)) throw new Error('Your permission to change native room powers was removed.');
  const next = { ...preserveCreator(room, powers), events: { ...powers.events } };
  const check = (before: number, after: number) => { if (!Number.isSafeInteger(before) || before > level || after > level) throw new Error('These permissions are above your native room authority.'); };
  if (changes.invite !== (powers.invite ?? 0)) { check(powers.invite ?? 0, changes.invite); next.invite = changes.invite; }
  for (const [event, value] of Object.entries({ 'm.room.message': changes.post, 'm.room.encrypted': changes.post, 'm.room.pinned_events': changes.pin, 'org.matrix.msc3401.call.member': changes.conference })) {
    const before = powers.events?.[event] ?? (event === 'm.room.message' || event === 'm.room.encrypted' ? powers.events_default ?? 0 : powers.state_default ?? 50);
    if (before !== value) { check(before, value); next.events[event] = value; }
  }
  await client.sendStateEvent(roomId, 'm.room.power_levels' as any, next, '');
}
