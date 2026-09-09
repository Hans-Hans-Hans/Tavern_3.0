import { getMatrixClient } from './matrix';
import { checkedConversationState, canEditConversationState } from './channel-administration';
import type { Profile } from './community';

export const profileMetadataPolicyEvent = 'io.tavern.server.profile_policy';
export const profileBioLimits = [0, 160, 500, 1000] as const;
export const profileStatusLimits = [0, 40, 80, 160] as const;
export type ProfileMetadataPolicy = { version: 1; enabled: boolean; allowLinks: boolean; allowCustomFields: boolean; maxBioLength: number; maxStatusLength: number };
export type ApplicableProfileMetadataPolicy = ProfileMetadataPolicy & { status: 'ready' | 'unavailable'; serverIds: string[]; reason?: string };
export const emptyProfileMetadataPolicy = (): ProfileMetadataPolicy => ({ version: 1, enabled: false, allowLinks: true, allowCustomFields: true, maxBioLength: 1000, maxStatusLength: 160 });
const privateType = 'io.tavern.private_thread';
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown, prefix: string): value is string => typeof value === 'string' && value.startsWith(prefix) && value.length >= 2 && value.length <= 1024 && !/[\s\x00-\x1f\x7f]/.test(value);
const content = (room: any, type: string, key = '') => room?.currentState.getStateEvents(type, key)?.getContent() || {};
const event = (room: any, type: string) => room?.currentState.getStateEvents(type, '');
const unavailable = 'The current server profile rules are unavailable. Wait for the server to sync or ask its owner to repair them.';

export function parseProfileMetadataPolicy(value: unknown): ProfileMetadataPolicy | null {
  if (!object(value) || value.version !== 1 || ['enabled', 'allowLinks', 'allowCustomFields'].some(key => typeof value[key] !== 'boolean')
    || !(profileBioLimits as readonly unknown[]).includes(value.maxBioLength) || !(profileStatusLimits as readonly unknown[]).includes(value.maxStatusLength)
    || Object.keys(value).some(key => !['version', 'enabled', 'allowLinks', 'allowCustomFields', 'maxBioLength', 'maxStatusLength', 'io.tavern.previous_event'].includes(key))
    || value['io.tavern.previous_event'] !== undefined && value['io.tavern.previous_event'] !== null && !id(value['io.tavern.previous_event'], '$')) return null;
  return { version: 1, enabled: value.enabled, allowLinks: value.allowLinks, allowCustomFields: value.allowCustomFields, maxBioLength: value.maxBioLength, maxStatusLength: value.maxStatusLength };
}
const parseSavedPolicy = (value: unknown) => object(value) && Object.hasOwn(value, 'io.tavern.previous_event') ? parseProfileMetadataPolicy(value) : null;
export function readServerProfileMetadataPolicy(serverId: string) {
  const saved = event(getMatrixClient()?.getRoom(serverId), profileMetadataPolicyEvent);
  return saved ? parseSavedPolicy(saved.getContent()) : emptyProfileMetadataPolicy();
}
function parentIds(room: any): string[] {
  const parents = room.currentState.getStateEvents('m.space.parent').filter((item: any) => item.getContent().canonical === true && item.getContent().via?.length);
  if (parents.length > 32 || parents.some((item: any) => !id(item.getStateKey(), '!'))) throw new Error(unavailable);
  return [...new Set<string>(parents.map((item: any) => item.getStateKey()))];
}
function sourceId(room: any): string | null {
  const creation = content(room, 'm.room.create');
  if (creation.type !== privateType) return null;
  const binding = creation[privateType];
  if (creation['m.federate'] !== false || !object(binding) || binding.version !== 1 || Object.keys(binding).sort().join(',') !== 'source_event_id,source_room_id,version'
    || !id(binding.source_room_id, '!') || binding.source_event_id !== '' && !id(binding.source_event_id, '$')) throw new Error(unavailable);
  return binding.source_room_id;
}
function scopedRooms(roomId: string, lookup: (id: string) => any) {
  const original = lookup(roomId); if (!original) throw new Error(unavailable);
  const source = sourceId(original), room = source ? lookup(source) : original;
  if (!room || !event(room, 'm.room.create') || source && ['m.space', privateType].includes(content(room, 'm.room.create').type)) throw new Error(unavailable);
  const parents = parentIds(room).map(parentId => {
    const parent = lookup(parentId); if (!parent || !event(parent, 'm.room.create')) throw new Error(unavailable);
    return content(parent, 'm.space.child', room.roomId).via?.length ? parent : null;
  }).filter(Boolean);
  return { original, source: room, rooms: [room, ...parents] };
}
function combined(rooms: any[]): ApplicableProfileMetadataPolicy {
  const result: ApplicableProfileMetadataPolicy = { ...emptyProfileMetadataPolicy(), status: 'ready', serverIds: [] };
  for (const room of rooms) {
    const saved = event(room, profileMetadataPolicyEvent); if (!saved) continue;
    const policy = parseSavedPolicy(saved.getContent()), create = content(room, 'm.room.create');
    if (!policy || policy.enabled && (create.type !== 'm.space' || create['m.federate'] !== false)) throw new Error(unavailable);
    if (!policy.enabled) continue;
    result.enabled = true; result.serverIds.push(room.roomId);
    result.allowLinks &&= policy.allowLinks; result.allowCustomFields &&= policy.allowCustomFields;
    result.maxBioLength = Math.min(result.maxBioLength, policy.maxBioLength); result.maxStatusLength = Math.min(result.maxStatusLength, policy.maxStatusLength);
  }
  return result;
}
export function profilePolicyForRoom(roomId: string): ApplicableProfileMetadataPolicy {
  try { const client = getMatrixClient(); return combined(scopedRooms(roomId, value => client?.getRoom(value)).rooms); }
  catch { return { ...emptyProfileMetadataPolicy(), status: 'unavailable', serverIds: [], reason: unavailable }; }
}
export function profileMetadataPolicyError(profile: Pick<Profile, 'bio' | 'status' | 'links' | 'fields'> & Partial<Pick<Profile, 'statusEmoji'>>, rules: ApplicableProfileMetadataPolicy): string | null {
  if (rules.status !== 'ready') return rules.reason || unavailable;
  if (!rules.enabled) return null;
  const reasons: string[] = [];
  if (!rules.allowLinks && profile.links.length) reasons.push('Profile links are disabled');
  if (!rules.allowCustomFields && profile.fields.length) reasons.push('Custom profile fields are disabled');
  if (profile.bio.length > rules.maxBioLength) reasons.push(`Bio must be at most ${rules.maxBioLength} characters`);
  if (!rules.maxStatusLength && (profile.status.length || profile.statusEmoji)) reasons.push('Status and status emoji are disabled');
  else if (profile.status.length > rules.maxStatusLength) reasons.push(`Status must be at most ${rules.maxStatusLength} characters`);
  return reasons.length ? reasons.join('. ') + '. Your draft has been kept.' : null;
}
function boundedText(value: string, length: number) { const text = value.slice(0, length); return /[\ud800-\udbff]$/.test(text) ? text.slice(0, -1) : text; }
export function applyProfileMetadataPolicy<T extends Profile>(profile: T, rules: ApplicableProfileMetadataPolicy): T {
  if (rules.status !== 'ready') throw new Error(rules.reason || unavailable);
  return { ...profile, links: rules.enabled && !rules.allowLinks ? [] : profile.links.map(link => ({ ...link })), fields: rules.enabled && !rules.allowCustomFields ? [] : profile.fields.map(field => ({ ...field })),
    bio: boundedText(profile.bio, rules.enabled ? rules.maxBioLength : 1000), status: boundedText(profile.status, rules.enabled ? rules.maxStatusLength : 160),
    statusEmoji: rules.enabled && !rules.maxStatusLength ? '' : profile.statusEmoji, statusUntil: rules.enabled && !rules.maxStatusLength ? 0 : profile.statusUntil };
}
/** Presentation only: older membership events remain readable through Matrix. */
export function visibleProfileMetadata<T extends Profile>(profile: T, roomId: string): T {
  const rules = profilePolicyForRoom(roomId);
  return rules.status === 'ready' ? applyProfileMetadataPolicy(profile, rules) : { ...profile, bio: '', status: '', statusEmoji: '', statusUntil: 0, links: [], fields: [] };
}
function roomFromState(roomId: string, values: any[]) {
  if (!Array.isArray(values) || values.length > 50000) throw new Error(unavailable);
  const entries = new Map<string, any>();
  for (const value of values) {
    if (!object(value) || typeof value.type !== 'string' || typeof value.state_key !== 'string' || !object(value.content)) throw new Error(unavailable);
    const key = value.type + '\0' + value.state_key; if (entries.has(key)) throw new Error(unavailable);
    entries.set(key, { getContent: () => value.content, getStateKey: () => value.state_key, getId: () => value.event_id, getSender: () => value.sender, type: value.type });
  }
  return { roomId, currentState: { getStateEvents: (type: string, key?: string) => key === undefined ? [...entries.values()].filter(item => item.type === type) : entries.get(type + '\0' + key) || null } };
}
export async function checkProfileMetadataPublication(roomId: string, profile: Profile, expectedClient = getMatrixClient(), project = false) {
  const client = expectedClient, actor = client?.getUserId();
  const current = () => client && getMatrixClient() === client && client.getUserId() === actor && client.getRoom(roomId)?.getMyMembership() === 'join';
  if (!client || !actor || !current()) throw new Error('Your account or conversation membership changed.');
  const rooms = new Map<string, ReturnType<typeof roomFromState>>();
  const load = async (identity: string) => { if (!current()) throw new Error('Your account or conversation membership changed.'); const room = roomFromState(identity, await client.roomState(identity)); if (!current()) throw new Error('Your account or conversation membership changed.'); rooms.set(identity, room); return room; };
  const original = await load(roomId), source = sourceId(original), base = source ? await load(source) : original;
  const parents = parentIds(base); // Bound the entire parent set before any parent request.
  for (const parent of parents) if (!rooms.has(parent)) await load(parent);
  const scope = scopedRooms(roomId, identity => rooms.get(identity));
  if ([scope.original, ...scope.rooms].some(room => content(room, 'm.room.member', actor).membership !== 'join')) throw new Error('Join the conversation and its current source servers before publishing a profile.');
  const rules = combined(scope.rooms), publication = project ? applyProfileMetadataPolicy(profile, rules) : profile, failure = profileMetadataPolicyError(publication, rules);
  if (failure) throw new Error(failure);
  if (!current()) throw new Error('Your account or conversation membership changed.');
  return { client, actor, membership: content(original, 'm.room.member', actor), rules, profile: publication };
}
export function canManageProfileMetadataPolicy(serverId: string) {
  const client = getMatrixClient(), room = client?.getRoom(serverId), creation = event(room, 'm.room.create');
  if (!event(room, 'io.tavern.roles') && creation?.getSender() !== client?.getUserId()) return false;
  return !!(room?.isSpaceRoom() && creation?.getContent()['m.federate'] === false && canEditConversationState(serverId, profileMetadataPolicyEvent));
}
export async function saveProfileMetadataPolicy(serverId: string, value: ProfileMetadataPolicy, previous: ProfileMetadataPolicy | null) {
  const next = parseProfileMetadataPolicy(value), owner = getMatrixClient();
  if (!next || !canManageProfileMetadataPolicy(serverId)) throw new Error('Choose valid profile rules and check your server permissions.');
  const client = await checkedConversationState(serverId, profileMetadataPolicyEvent);
  if (client !== owner) throw new Error('Your account changed. Reopen these settings.');
  const fresh = roomFromState(serverId, await client.roomState(serverId)), saved = event(fresh, profileMetadataPolicyEvent);
  const current = saved ? parseSavedPolicy(saved.getContent()) : emptyProfileMetadataPolicy();
  if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('Profile rules changed. Your draft is preserved. Reload the current rules before saving.');
  if (saved && !id(saved.getId(), '$')) throw new Error('The current profile rule revision is unavailable.');
  const checked = await checkedConversationState(serverId, profileMetadataPolicyEvent);
  if (checked !== owner || getMatrixClient() !== owner || !canManageProfileMetadataPolicy(serverId)) throw new Error('Your account or server permissions changed.');
  await client.sendStateEvent(serverId, profileMetadataPolicyEvent as any, { ...next, 'io.tavern.previous_event': saved?.getId() ?? null }, '');
  if (getMatrixClient() !== owner) throw new Error('Your account changed while the profile rules were saving.');
  return next;
}
