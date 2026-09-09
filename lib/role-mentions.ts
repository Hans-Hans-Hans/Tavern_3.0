import { parseMessageMarkdown, roleMentionLinks, roleMentionOrdinaryText } from './message-markdown';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { parseRolePolicy, rolesEvent, type RolePolicy } from './roles';
import { privateThreadBinding } from './private-threads';
import { roleMentionUri, type RoleMentionIdentity } from './role-mention-token';

export const roleMentionLimits = { roles: 20, recipients: 1000, encodedBytes: 16384, contentBytes: 32768, members: 10000, membershipWaitMs: 20000 } as const;
export type RoleMentionChoice = RoleMentionIdentity & { name: string; serverName: string };
type Scope = { room: Room; source: Room; servers: { room: Room; policy: RolePolicy }[] };
const value = (room: Room, type: string, key = '') => room.currentState.getStateEvents(type as any, key)?.getContent();
const via = (content: any) => Array.isArray(content?.via) && content.via.length > 0 && content.via.length <= 20 && content.via.every((entry: unknown) => typeof entry === 'string' && !!entry && entry.length <= 255);
export function selectedRoleMentions(body: string): RoleMentionIdentity[] {
  if (!/tavern-role:/i.test(body)) return [];
  if (body.length > 8000) throw new Error('A message with role mentions must fit within 8,000 characters.');
  if (parseMessageMarkdown(body).plain) throw new Error('This message has too much formatting for role mentions. Simplify it before sending.');
  const selected = roleMentionLinks(body);
  if (selected.length > roleMentionLimits.roles) throw new Error('Mention up to 20 server roles in one message.');
  return [...new Map(selected.map(identity => [roleMentionUri(identity.serverId, identity.roleId), identity])).values()];
}

export function bodyWithoutRoleLabels(body: string, _identities?: RoleMentionIdentity[]): string {
  const ordinary = roleMentionOrdinaryText(body);
  if (/tavern-role:/i.test(ordinary)) throw new Error('This role example is ambiguous. Put the complete role token in code formatting or remove it before sending. Your draft is kept.');
  return ordinary;
}

function context(client: MatrixClient, roomId: string): Scope {
  const actor = client.getUserId(), room = client.getRoom(roomId);
  if (!actor || !room || room.getMyMembership() !== 'join') throw new Error('Join this conversation before mentioning a server role.');
  let source = room;
  if (value(room, 'm.room.create')?.type === 'io.tavern.private_thread') {
    const binding = privateThreadBinding(room), candidate = binding && client.getRoom(binding.source_room_id);
    if (!candidate || candidate === room || candidate.getMyMembership() !== 'join' || ['m.space', 'io.tavern.private_thread'].includes(value(candidate, 'm.room.create')?.type) || value(candidate, 'm.room.create')?.['m.federate'] !== false || value(candidate, 'm.room.encryption')?.algorithm !== 'm.megolm.v1.aes-sha2') throw new Error('The private discussion source is unavailable. Remove the role mention or rejoin its source.');
    source = candidate;
  }
  const parents = source.currentState.getStateEvents('m.space.parent').filter(event => event.getContent().canonical === true && via(event.getContent()));
  if (parents.length > 10) throw new Error('This conversation has too many canonical servers for role mentions.');
  const servers: Scope['servers'] = [];
  for (const parent of parents) {
    const id = parent.getStateKey(), server = id ? client.getRoom(id) : null;
    if (!server || server.getMyMembership() !== 'join' || !server.isSpaceRoom() || !via(value(server, 'm.space.child', source.roomId))) throw new Error('The current canonical server membership is unavailable. Reopen the conversation before mentioning a role.');
    const state = server.currentState.getStateEvents(rolesEvent, '');
    if (!state) continue;
    const policy = parseRolePolicy(state.getContent());
    if (!policy) throw new Error('The current server roles are invalid. Remove the role mention or wait for the server policy to be repaired.');
    servers.push({ room: server, policy });
  }
  return { room, source, servers };
}
export function roleMentionChoices(client: MatrixClient | null, roomId: string): RoleMentionChoice[] {
  if (!client) return [];
  try {
    return context(client, roomId).servers.flatMap(({ room, policy }) => policy.roles.filter(role => role.mentionable).map(role => ({ serverId: room.roomId, serverName: room.name || room.roomId, roleId: role.id, name: role.name })))
      .sort((a, b) => a.serverName.localeCompare(b.serverName) || a.name.localeCompare(b.name) || a.roleId.localeCompare(b.roleId));
  } catch { return []; }
}
function topology(scope: Scope): string {
  return JSON.stringify([scope.room.roomId, scope.source.roomId, value(scope.room, 'm.room.create'),
    scope.source.currentState.getStateEvents('m.space.parent').map(event => [event.getStateKey(), event.getContent()]),
    scope.servers.map(server => [server.room.roomId, value(server.room, 'm.space.child', scope.source.roomId)])]);
}
async function boundedMembers(room: Room): Promise<void> {
  if (room.getJoinedMemberCount() > roleMentionLimits.members) throw new Error('This conversation is too large to safely expand server roles. Mention individual people instead.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([room.loadMembersIfNeeded(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Loading role recipients timed out. Your draft is kept; wait for sync and retry.')), roleMentionLimits.membershipWaitMs); })]);
  } finally { clearTimeout(timer); }
  completeMembership(room);
}
function completeMembership(room: Room): void {
  const known = room.getJoinedMembers().length, reported = room.getJoinedMemberCount();
  if (!Number.isSafeInteger(reported) || reported < 0 || known !== reported || known > roleMentionLimits.members) throw new Error('The full current membership is unavailable. Your role mention has not been sent.');
}

export async function expandRoleMentions(client: MatrixClient, roomId: string, body: string, current: () => boolean) {
  const identities = selectedRoleMentions(body);
  if (!identities.length) return /tavern-role:/i.test(body) ? { userIds: [], bodyForUserMentions: bodyWithoutRoleLabels(body), assertCurrent: () => { if (!current()) throw new Error('Your account changed. Reopen this conversation.'); } } : null;
  if (!current()) throw new Error('Your account changed. Reopen this conversation.');
  const before = context(client, roomId), stamp = topology(before), actor = client.getUserId();
  const rooms = [...new Set([before.room, before.source, ...before.servers.filter(server => identities.some(identity => identity.serverId === server.room.roomId)).map(server => server.room)])];
  // Reject foreign and no-longer-mentionable role tokens before requesting any
  // membership. Only already joined, canonical source scopes can be loaded.
  const requireRoles = (scope: Scope) => identities.map(identity => {
    const server = scope.servers.find(server => server.room.roomId === identity.serverId), role = server?.policy.roles.find(role => role.id === identity.roleId);
    if (!server || !role?.mentionable) throw new Error('A selected role is no longer mentionable in this conversation. Remove it or choose a current role.');
    return { ...identity, server, role };
  });
  requireRoles(before);
  for (const room of rooms) { await boundedMembers(room); if (!current() || client.getUserId() !== actor || client.getRoom(room.roomId) !== room || room.getMyMembership() !== 'join') throw new Error('Your account or room membership changed while loading role recipients. Your draft is kept.'); }
  let audienceStamp: string | undefined;
  const audience = (scope: Scope) => JSON.stringify([rooms.map(room => [room.roomId, room.getJoinedMembers().map(member => member.userId).sort()]),
    requireRoles(scope).map(({ server, role }) => [server.room.roomId, role.id, role.mentionable, server.policy.members])]);
  const assertCurrent = () => {
    if (!current() || client.getUserId() !== actor || rooms.some(room => client.getRoom(room.roomId) !== room || room.getMyMembership() !== 'join')) throw new Error('Your account or conversation changed. Reopen it before sending.');
    rooms.forEach(completeMembership);
    const fresh = context(client, roomId);
    if (topology(fresh) !== stamp) throw new Error('The conversation server or source changed. Choose its roles again before sending.');
    requireRoles(fresh);
    if (audienceStamp !== undefined && audience(fresh) !== audienceStamp) throw new Error('Role recipients changed while preparing the message. Your draft is kept; review the role and retry.');
    return fresh;
  };
  const fresh = assertCurrent(), selected = requireRoles(fresh), userIds = new Set<string>();
  for (const member of fresh.room.getJoinedMembers()) {
    if (member.membership !== 'join' || fresh.source.getMember(member.userId)?.membership !== 'join') continue;
    if (selected.some(({ server, role }) => server.room.getMember(member.userId)?.membership === 'join' && (role.id === 'everyone' || server.policy.members[member.userId]?.includes(role.id)))) userIds.add(member.userId);
    if (userIds.size > roleMentionLimits.recipients) throw new Error('These roles include more than 1,000 joined recipients. Choose fewer roles; nothing has been sent.');
  }
  audienceStamp = audience(fresh);
  return { userIds: [...userIds], bodyForUserMentions: bodyWithoutRoleLabels(body, identities), assertCurrent };
}

export function checkRoleMentionSize(mentions: { user_ids: string[]; room?: boolean }, content?: unknown): void {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (mentions.user_ids.length > roleMentionLimits.recipients || encode(mentions) > roleMentionLimits.encodedBytes) throw new Error('The selected mentions are too large for one message. Mention fewer people or roles; nothing has been sent.');
  if (content !== undefined && encode(content) > roleMentionLimits.contentBytes) throw new Error('This message and its role mentions are too large. Shorten it or choose fewer roles; nothing has been sent.');
}
