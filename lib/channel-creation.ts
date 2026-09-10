import { Preset, Visibility, type MatrixClient } from 'matrix-js-sdk';
import { getMatrixClient } from './matrix';
import { accountArtworkOwner } from './api';
import { readInstanceConfig } from './instance';
import { channelKinds, type ChannelKind } from './channel-policy';
import { normalizeServerLayout, type ServerLayout } from './community';
import { effectiveRolePermissions, mayEditCategoryLayout, nativeMemberPower, parseRolePolicy, resolveRoomCategory, rolesEvent } from './roles';

export const channelTemplates: Record<ChannelKind, { description: string; purpose: string; icon: string; guidance: string }> = {
  text: { description: 'Everyday conversations, links and attachments.', purpose: 'What will people talk about?', icon: '💬', guidance: 'Members can post messages, reply in threads and share files, subject to their permissions.' },
  voice: { description: 'A place to meet and talk, with persistent chat.', purpose: 'What is this voice room for?', icon: '🔊', guidance: 'People choose when to join audio. Creating the channel does not turn on a microphone.' },
  video: { description: 'Meet face to face, share a screen and keep the chat.', purpose: 'What happens in this meeting room?', icon: '📹', guidance: 'People choose their camera and microphone when joining. Conference permissions still apply.' },
  forum: { description: 'Organize longer conversations into named discussions.', purpose: 'What topics belong in this forum?', icon: '🗂️', guidance: 'Members create discussion posts with titles and tags, then reply in their threads.' },
  announcement: { description: 'Updates posted by authorized moderators.', purpose: 'What announcements belong here?', icon: '📣', guidance: 'Only authorized moderators can publish posts. Members can read and react when their permissions allow.' },
  rules: { description: 'A reference channel for community rules and guidance.', purpose: 'Describe the rules or guidance this channel contains.', icon: '📋', guidance: 'Only authorized moderators can publish posts. Put the rules in messages after creating the channel; the description is room metadata.' },
  media: { description: 'A shared place for photos, videos and files.', purpose: 'What should people share here?', icon: '🖼️', guidance: 'Members can share encrypted attachments and messages. This channel does not enforce a file-only restriction.' },
  'read-only': { description: 'Reference material maintained by moderators.', purpose: 'What should people find here?', icon: '📖', guidance: 'Only authorized moderators can publish posts. Existing history remains available to authorized members.' },
};
export const channelSlowModes = [0, 5, 10, 30, 60, 300, 900, 3600, 21600] as const;
export type ChannelDraft = { name: string; description: string; kind: ChannelKind; slowModeSeconds: number; serverId?: string; categoryId: string; members: string[]; icon: string };
export type ChannelCreationResult = { roomId: string; name: string; linked: boolean; categoryApplied: boolean; invited: string[]; pendingMembers: string[]; errors: string[] };
type Native = { type: string; state_key: string; content: any; sender?: string };
type Owner = { client: MatrixClient; user: string; device: string; account: object; homeserver: string };
type Scope = { id: string; child: string; events: Native[] };
type Pending = { owner: Owner; draft: ChannelDraft; running: boolean };
const pending = new WeakMap<ChannelCreationResult, Pending>();
const layoutEvent = 'io.tavern.server.layout';
const roomId = (value: unknown): value is string => typeof value === 'string' && /^![^\s/\\?#\x00-\x1f\x7f]{1,254}$/.test(value);
const state = (events: Native[], type: string, key = '') => events.find(event => event.type === type && event.state_key === key)?.content;
const event = (events: Native[], type: string, key = '') => events.find(value => value.type === type && value.state_key === key);
function requireCurrent(owner: Owner) {
  if (getMatrixClient() !== owner.client || owner.client.getUserId() !== owner.user || owner.client.getDeviceId() !== owner.device
    || accountArtworkOwner() !== owner.account || owner.client.getHomeserverUrl() !== owner.homeserver) throw new Error('Your account changed. Open channel creation again from the current account.');
}
function owner(): Owner {
  const client = getMatrixClient(), user = client?.getUserId(), device = client?.getDeviceId();
  if (!client || !user || !device) throw new Error('Sign in before creating a channel.');
  return { client, user, device, account: accountArtworkOwner(), homeserver: client.getHomeserverUrl() };
}
export function channelCreationOwner() { try { return owner(); } catch { return null; } }
export function isChannelCreationOwner(value: ReturnType<typeof channelCreationOwner>) { try { if (!value) return false; requireCurrent(value); return true; } catch { return false; } }
function localUser(value: string, actor: string) { return /^@[^\s:]+:[^\s]+$/.test(value) && value.length <= 255 && value.slice(value.indexOf(':')) === actor.slice(actor.indexOf(':')); }
export function validateChannelDraft(value: ChannelDraft, actor: string): ChannelDraft {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 60 || /[\x00-\x1f\x7f]/.test(value.name)
    || typeof value.description !== 'string' || value.description.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.description)
    || !Object.hasOwn(channelKinds, value.kind) || !Number.isInteger(value.slowModeSeconds) || value.slowModeSeconds < 0 || value.slowModeSeconds > 21600
    || typeof value.icon !== 'string' || value.icon.length > 16 || /[\x00-\x1f\x7f]/.test(value.icon)
    || value.serverId && !roomId(value.serverId) || typeof value.categoryId !== 'string' || value.categoryId && !/^[\w-]{1,80}$/.test(value.categoryId)
    || !value.serverId && value.categoryId || !Array.isArray(value.members) || value.members.length > 50
    || value.members.some(id => typeof id !== 'string' || !localUser(id, actor))) throw new Error('Enter a channel name, a description of up to 500 characters and up to 50 local members. Review the selected channel settings.');
  return { ...value, name: value.name.trim(), members: [...new Set(value.members)].filter(id => id !== actor) };
}
async function native(owner: Owner, id: string) {
  requireCurrent(owner);
  const values = await owner.client.roomState(id); requireCurrent(owner);
  if (!Array.isArray(values) || values.length > 10000) throw new Error('This room state is unavailable or too large to check safely.');
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value.type !== 'string' || typeof value.state_key !== 'string' || !value.content || typeof value.content !== 'object' || Array.isArray(value.content)
      || value.room_id !== undefined && value.room_id !== id) throw new Error('The current room state is invalid.');
    const key = JSON.stringify([value.type, value.state_key]); if (seen.has(key)) throw new Error('The current room state is ambiguous.'); seen.add(key);
  }
  return values as Native[];
}
function nativePower(events: Native[], user: string) { return nativeMemberPower({ currentState: { getStateEvents: (type: string, key: string) => { const value = event(events, type, key); return value ? { getContent: () => value.content, getSender: () => value.sender } : null; } } }, user); }
function threshold(events: Native[], type: string) { const value = state(events, 'm.room.power_levels')?.events?.[type] ?? state(events, 'm.room.power_levels')?.state_default ?? 50; if (!Number.isSafeInteger(value)) throw new Error('Native room permissions are invalid.'); return value; }
function layout(events: Native[]): ServerLayout {
  const raw = state(events, layoutEvent), children = events.filter(value => value.type === 'm.space.child' && Array.isArray(value.content.via) && value.content.via.length).map(value => value.state_key);
  const value = normalizeServerLayout(raw);
  if (raw && (raw.version !== 1 || !Array.isArray(raw.categories) || !Array.isArray(raw.channels) || raw.categories.length !== value.categories.length
    || raw.categories.length > 100 || raw.channels.length > 1000 || raw.channels.length !== value.channels.length
    || raw.channels.some((item: any, index: number) => (item.category || '') !== value.channels[index].category))) throw new Error('The server category layout needs repair before creating a channel.');
  // Preserve unrelated saved entries; add the new native child without dropping
  // another channel just because its link is temporarily absent from this read.
  return normalizeServerLayout(value, [...new Set([...value.channels.map(channel => channel.id), ...children])]);
}
function selectedLayout(events: Native[], draft: ChannelDraft, id: string) {
  const before = layout(events);
  if (draft.categoryId && !before.categories.some(category => category.id === draft.categoryId)) throw new Error('The selected category no longer exists. Choose its current destination.');
  if (!before.channels.some(channel => channel.id === id) && before.channels.length >= 1000) throw new Error('This server has reached its channel layout limit.');
  return { before, after: { ...before, channels: [...before.channels.filter(channel => channel.id !== id), { id, category: draft.categoryId }] } };
}
function authorize(scopes: Scope[], owner: Owner, draft: ChannelDraft, id = '!channel-creation:pending') {
  for (const scope of scopes) {
    const create = state(scope.events, 'm.room.create');
    if (create?.type !== 'm.space' || create['m.federate'] !== false || state(scope.events, 'm.room.member', owner.user)?.membership !== 'join') throw new Error('Join each current local parent server before creating a channel.');
    const raw = state(scope.events, rolesEvent), policy = raw ? parseRolePolicy(raw) : null;
    if (raw && !policy) throw new Error('The server role policy is unavailable or invalid.');
    if (policy && !effectiveRolePermissions(policy, owner.user, scope.child || id, scope.id === draft.serverId ? draft.categoryId : resolveRoomCategory(state(scope.events, layoutEvent), scope.child)).has('manage_channels')) throw new Error('Your current server role cannot create or organize this channel.');
    if (scope.id === draft.serverId) {
      if (nativePower(scope.events, owner.user) < threshold(scope.events, 'm.space.child')) throw new Error('You cannot add channels to this server.');
      if (draft.categoryId) {
        if (nativePower(scope.events, owner.user) < threshold(scope.events, layoutEvent)) throw new Error('You cannot place channels into this server’s categories.');
        const { before, after } = selectedLayout(scope.events, draft, id);
        if (policy && !mayEditCategoryLayout(policy, owner.user, before, after)) throw new Error('Only the server owner can place a new channel across category permission boundaries.');
      }
      if (draft.members.some(user => state(scope.events, 'm.room.member', user)?.membership !== 'join')) throw new Error('An invited member is no longer joined to this server. Review the member list.');
    }
  }
}
async function serverScopes(owner: Owner, draft: ChannelDraft, id?: string) {
  if (!draft.serverId) { requireCurrent(owner); return []; }
  const scopes: Scope[] = [], visiting = new Set<string>(); let count = 0;
  async function visit(server: string, child: string, depth: number) {
    if (depth > 8 || ++count > 32 || visiting.has(server)) throw new Error('The server hierarchy is too large or cyclic to check safely.');
    visiting.add(server); const events = await native(owner, server);
    if (child && !state(events, 'm.space.child', child)?.via?.length) throw new Error('The parent server relationship changed. Reopen channel creation.');
    scopes.push({ id: server, child, events });
    const parents = events.filter(value => value.type === 'm.space.parent' && value.content.canonical === true);
    if (parents.length > 32) throw new Error('The server has too many canonical parents.');
    for (const parent of parents) {
      if (!roomId(parent.state_key) || !Array.isArray(parent.content.via) || !parent.content.via.length) throw new Error('A canonical parent relationship is invalid.');
      await visit(parent.state_key, server, depth + 1);
    }
    visiting.delete(server);
  }
  await visit(draft.serverId, '', 0); authorize(scopes, owner, draft, id);
  // Recheck the complete authority/topology snapshot after all awaited reads.
  // Native authorization remains the final check; these reads are not a
  // cross-room transaction or a guarantee against later changes.
  for (const scope of scopes) if (fingerprint(await native(owner, scope.id)) !== fingerprint(scope.events)) throw new Error('Server permissions or memberships changed while checking. Review the channel before retrying.');
  requireCurrent(owner); return scopes;
}
function fingerprint(events: Native[]) { return JSON.stringify(events.filter(value => ['m.room.create', 'm.room.member', 'm.room.power_levels', 'm.space.parent', 'm.space.child', rolesEvent, layoutEvent].includes(value.type)).map(value => [value.type, value.state_key, value.sender, value.content]).sort((a, b) => String(a[0] + '\0' + a[1]).localeCompare(String(b[0] + '\0' + b[1])))); }
function proveCreated(owner: Owner, draft: ChannelDraft, events: Native[]) {
  const create = event(events, 'm.room.create'), parents = events.filter(value => value.type === 'm.space.parent' && value.content.canonical === true);
  if (create?.sender !== owner.user || create.content['m.federate'] !== false || create.content.type !== undefined
    || state(events, 'm.room.member', owner.user)?.membership !== 'join'
    || state(events, 'm.room.encryption')?.algorithm !== 'm.megolm.v1.aes-sha2'
    || state(events, 'm.room.history_visibility')?.history_visibility !== 'joined'
    || (draft.serverId ? parents.length !== 1 || parents[0].state_key !== draft.serverId || !Array.isArray(parents[0].content.via) || !parents[0].content.via.length : parents.length !== 0))
    throw new Error('The created channel’s ownership, membership, encryption or server relationship changed. Review it in All conversations.');
}

export async function createTypedChannel(value: ChannelDraft): Promise<ChannelCreationResult> {
  const current = owner(), draft = validateChannelDraft(value, current.user), config = await readInstanceConfig(); requireCurrent(current);
  if (!config.serverRolePolicy && (draft.kind !== 'text' || draft.slowModeSeconds)) throw new Error('Typed channel behavior is unavailable on this homeserver. Create a text channel or enable the Tavern policy module first.');
  await serverScopes(current, draft);
  const restricted = ['announcement', 'rules', 'read-only'].includes(draft.kind), via = [current.user.slice(current.user.indexOf(':') + 1)];
  let created;
  try {
    created = await current.client.createRoom({ name: draft.name, topic: draft.description || undefined, visibility: Visibility.Private, preset: Preset.PrivateChat,
      creation_content: { 'm.federate': false }, power_level_content_override: { events: { 'org.matrix.msc3401.call.member': 0,
        ...(config.serverRolePolicy ? { 'io.tavern.thread': 0 } : {}), ...(restricted ? { 'm.room.message': 50, 'm.room.encrypted': 50 } : {}) } },
      initial_state: [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
        { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
        ...(draft.serverId ? [{ type: 'm.space.parent', state_key: draft.serverId, content: { canonical: true, via } }] : []),
        ...(config.serverRolePolicy ? [{ type: 'io.tavern.channel', state_key: '', content: { version: 1, kind: draft.kind, slowModeSeconds: draft.slowModeSeconds, archived: false, icon: draft.icon } }] : []),
      ] });
  } catch { throw new Error('Channel creation was not confirmed. Check All conversations before creating it again; the server may already have created the room.'); }
  if (!roomId(created.room_id)) throw new Error('The server did not return a valid channel ID. Check All conversations before trying again.');
  const result: ChannelCreationResult = { roomId: created.room_id, name: draft.name, linked: !draft.serverId, categoryApplied: !draft.categoryId, invited: [], pendingMembers: [...draft.members], errors: [] };
  pending.set(result, { owner: current, draft, running: false });
  return finishChannelCreation(result);
}

export async function finishChannelCreation(result: ChannelCreationResult): Promise<ChannelCreationResult> {
  const operation = pending.get(result); if (!operation) throw new Error('Reopen the created channel to finish its settings.');
  if (operation.running) throw new Error('This channel is already being finished.');
  const { owner, draft } = operation; requireCurrent(owner); operation.running = true; result.errors = [];
  try {
    const room = await native(owner, result.roomId); proveCreated(owner, draft, room);
    await owner.client.joinRoom(result.roomId); requireCurrent(owner);
    if (draft.serverId) {
      const scopes = await serverScopes(owner, draft, result.roomId), parent = scopes.find(scope => scope.id === draft.serverId)!;
      if (!state(parent.events, 'm.space.child', result.roomId)?.via?.length) {
        await owner.client.sendStateEvent(draft.serverId, 'm.space.child' as any, { via: [owner.user.slice(owner.user.indexOf(':') + 1)] }, result.roomId); requireCurrent(owner);
      }
      result.linked = true;
      if (draft.categoryId) {
        const scopes = await serverScopes(owner, draft, result.roomId), parent = scopes.find(scope => scope.id === draft.serverId)!;
        const { before, after } = selectedLayout(parent.events, draft, result.roomId);
        if (before.channels.find(channel => channel.id === result.roomId)?.category !== draft.categoryId) {
          await owner.client.sendStateEvent(draft.serverId, layoutEvent as any, after, ''); requireCurrent(owner);
        }
        result.categoryApplied = true;
      }
    }
    // Invites are separate known-room operations. An ambiguous invite is read
    // back on retry, so acknowledged memberships are never blindly replayed.
    for (const target of [...result.pendingMembers]) {
      const scopes = await serverScopes(owner, draft, result.roomId);
      if (draft.serverId && !state(scopes.find(scope => scope.id === draft.serverId)!.events, 'm.space.child', result.roomId)?.via?.length)
        throw new Error('The channel’s server link changed before invitations were sent. Review the channel and retry its remaining setup.');
      const current = await native(owner, result.roomId), membership = state(current, 'm.room.member', target)?.membership;
      proveCreated(owner, draft, current);
      if (!['invite', 'join'].includes(membership)) {
        if (membership === 'ban') throw new Error('A selected member is banned from this channel. Review their membership before inviting them.');
        await owner.client.invite(result.roomId, target); requireCurrent(owner);
      }
      result.invited.push(target); result.pendingMembers = result.pendingMembers.filter(value => value !== target);
    }
  } catch (error) { requireCurrent(owner); result.errors.push((error as Error).message || 'The remaining channel setup could not be completed.'); }
  finally { operation.running = false; }
  return result;
}
