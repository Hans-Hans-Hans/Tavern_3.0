import type { Room } from 'matrix-js-sdk';
import { getMatrixClient } from './matrix';
import { authenticatedMatrixMediaUrl } from './matrix-media';
import { readImageResponse } from './response-image';
import { nativeSelfProfile } from './self-profile';
import { effectiveRolePermissions, mayEditCategoryLayout, readRolePolicy } from './roles';
import { serverNicknameForRoom } from './server-nickname';
import { checkProfileMetadataPublication, visibleProfileMetadata } from './profile-metadata-policy';

export const communityEvents = { layout: 'io.tavern.server.layout', channel: 'io.tavern.channel', profile: 'io.tavern.profile', preferences: 'io.tavern.community.preferences' } as const;
export type Category = { id: string; name: string; icon: string };
export type ServerLayout = { version: 1; categories: Category[]; channels: { id: string; category: string }[] };
export type ChannelAppearance = { version: 1; icon: string; accent: string; archived: boolean };
export type Profile = { version: 1; name: string; avatar: string; banner: string; bio: string; pronouns: string; timezone: string; language: string; accent: string; status: string; statusEmoji: string; statusUntil: number; links: { label: string; url: string }[]; fields: { label: string; value: string }[] };
const clean = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '';
const record = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
export const cleanMxc = (v: unknown) => typeof v === 'string' && /^mxc:\/\/[^\s/?#]+\/[^\s/?#]+$/.test(v) ? v.slice(0, 1024) : '';
const color = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '';
export function normalizeProfile(value: unknown, now = Date.now()): Profile {
  const p = record(value), expires = Number.isSafeInteger(p.statusUntil) && p.statusUntil > 0 ? p.statusUntil : 0;
  const links = Array.isArray(p.links) ? p.links.slice(0, 5).flatMap(link => {
    const l = record(link); try { const url = new URL(clean(l.url, 1000)); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? [{ label: clean(l.label, 60), url: url.href }] : []; } catch { return []; }
  }) : [];
  let timezone = clean(p.timezone, 80); if (timezone) try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { timezone = ''; }
  let language = clean(p.language, 30); if (language) try { language = Intl.getCanonicalLocales(language)[0] || ''; } catch { language = ''; }
  const fields = Array.isArray(p.fields) ? p.fields.slice(0, 8).flatMap(field => { const f = record(field), label = clean(f.label, 60).trim(), value = clean(f.value, 300).trim(); return label && value ? [{ label, value }] : []; }) : [];
  return { version: 1, name: clean(p.name, 60), avatar: cleanMxc(p.avatar), banner: cleanMxc(p.banner), bio: clean(p.bio, 1000), pronouns: clean(p.pronouns, 50), timezone, language, accent: color(p.accent), status: expires && expires <= now ? '' : clean(p.status, 160), statusEmoji: expires && expires <= now ? '' : clean(p.statusEmoji, 16), statusUntil: expires, links, fields };
}
export function profileStatusExpiration(choice: string, current = 0, now = Date.now()) { if (choice === 'keep') return current; if (choice === 'never') return 0; if (choice === 'today' || choice === 'week') { const date = new Date(now); if (choice === 'week') date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7)); date.setHours(choice === 'today' ? 24 : 0, 0, 0, 0); return date.getTime(); } const duration = Number(choice); if (![1800000, 3600000, 14400000, 86400000, 604800000].includes(duration)) throw new Error('Choose a valid status expiration.'); return now + duration; }
export function readMemberProfileContext(roomId: string, userId: string) { const c = getMatrixClient(), room = c?.getRoom(roomId), event = room?.currentState.getStateEvents('m.room.member', userId), previous = event?.getPrevContent()?.membership; const joinedAt = event?.getContent().membership === 'join' && ['invite', 'leave', 'ban', 'knock'].includes(previous || '') ? event!.getTs() : null; return { joinedAt, mutualServers: (c?.getRooms() || []).filter(r => r.isSpaceRoom() && r.getMyMembership() === 'join' && r.getMember(userId)?.membership === 'join').map(r => ({ id: r.roomId, name: r.name })).sort((a, b) => a.name.localeCompare(b.name)) }; }
export function normalizeChannelAppearance(value: unknown): ChannelAppearance { const p = record(value); return { version: 1, icon: clean(p.icon, 16), accent: color(p.accent), archived: p.archived === true }; }
export function normalizeServerLayout(value: unknown, roomIds?: string[]): ServerLayout {
  const p = record(value), categoryIds = new Set<string>(), channelIds = new Set<string>(), allowed = roomIds ? new Set(roomIds) : null;
  const categories: Category[] = [];
  for (const raw of Array.isArray(p.categories) ? p.categories.slice(0, 100) : []) { const c = record(raw), id = clean(c.id, 80), name = clean(c.name, 60).trim(); if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !name || categoryIds.has(id)) continue; categoryIds.add(id); categories.push({ id, name, icon: clean(c.icon, 16) }); }
  const channels: ServerLayout['channels'] = [];
  for (const raw of Array.isArray(p.channels) ? p.channels.slice(0, 1000) : []) { const c = record(raw), id = clean(c.id, 255); if (!id.startsWith('!') || channelIds.has(id) || (allowed && !allowed.has(id))) continue; channelIds.add(id); channels.push({ id, category: categoryIds.has(c.category) ? c.category : '' }); }
  for (const id of roomIds || []) if (!channelIds.has(id)) { channels.push({ id, category: '' }); channelIds.add(id); }
  return { version: 1, categories, channels };
}
export function moveChannel(layout: ServerLayout, channelId: string, category: string, beforeId?: string): ServerLayout {
  if (!layout.channels.some(c => c.id === channelId)) throw new Error('This channel is not part of the server.');
  if (category && !layout.categories.some(c => c.id === category)) throw new Error('This category no longer exists.');
  const channels = layout.channels.filter(c => c.id !== channelId), at = beforeId ? channels.findIndex(c => c.id === beforeId && c.category === category) : -1;
  channels.splice(at < 0 ? channels.length : at, 0, { id: channelId, category }); return { ...layout, channels };
}
function context(roomId?: string) { const c = getMatrixClient(), me = c?.getUserId(); if (!c || !me) throw new Error('Sign in to your homeserver first.'); const room = roomId ? c.getRoom(roomId) : null; if (roomId && (!room || room.getMyMembership() !== 'join')) throw new Error('Join this conversation first.'); return { c, me, room }; }
function state(room: Room | null | undefined, type: string, key = '') { return room?.currentState.getStateEvents(type, key)?.getContent() || {}; }
export function serverChannelIds(serverId: string): string[] { const r = getMatrixClient()?.getRoom(serverId); return r?.currentState.getStateEvents('m.space.child').filter(e => Array.isArray(e.getContent().via) && e.getContent().via.length > 0).map(e => e.getStateKey()!).filter(Boolean) || []; }
export function readServerLayout(serverId: string) { return normalizeServerLayout(state(getMatrixClient()?.getRoom(serverId), communityEvents.layout), serverChannelIds(serverId)); }
export function canEditCommunity(roomId: string, kind: 'layout' | 'channel') { const c = getMatrixClient(), me = c?.getUserId(), r = c?.getRoom(roomId); return !!(me && r?.getMyMembership() === 'join' && r.currentState.maySendStateEvent(communityEvents[kind], me)); }
export async function saveServerLayout(serverId: string, layout: ServerLayout) { const { c, me, room } = context(serverId); if (!room!.isSpaceRoom() || !room!.currentState.maySendStateEvent(communityEvents.layout, me)) throw new Error('You do not have permission to organize this server.'); const policy = readRolePolicy(serverId), next = normalizeServerLayout(layout, serverChannelIds(serverId)); if (policy) { if (!effectiveRolePermissions(policy, me).has('manage_channels')) throw new Error('You do not have permission to organize this server.'); let previous = {}; try { previous = await c.getStateEvent(serverId, communityEvents.layout as any, ''); } catch (e) { if ((e as any).errcode !== 'M_NOT_FOUND') throw e; } if (!mayEditCategoryLayout(policy, me, previous, next)) throw new Error('Only the server owner can move channels across category permission boundaries.'); } await c.sendStateEvent(serverId, communityEvents.layout as any, next, ''); }
export { readServerBranding, canEditServerBranding, saveServerBranding } from './server-branding';
export function readChannelAppearance(roomId: string) { return normalizeChannelAppearance(state(getMatrixClient()?.getRoom(roomId), communityEvents.channel)); }
export async function saveChannelAppearance(roomId: string, value: ChannelAppearance) { const { c, me, room } = context(roomId); if (!room!.currentState.maySendStateEvent(communityEvents.channel, me)) throw new Error('You do not have permission to customize this channel.'); let current = {}; try { current = await c.getStateEvent(roomId, communityEvents.channel as any, ''); } catch (e) { if ((e as any).errcode !== 'M_NOT_FOUND') throw e; } const appearance = normalizeChannelAppearance(value); await c.sendStateEvent(roomId, communityEvents.channel as any, { ...current, version: 1, icon: appearance.icon, accent: appearance.accent }, ''); }
export function readOwnProfile(serverId?: string): Profile {
  const c = getMatrixClient(), me = c?.getUserId() || '', user = nativeSelfProfile(c), p = serverId ? state(c?.getRoom(serverId), 'm.room.member', me) : null;
  return normalizeProfile(p ? { ...p[communityEvents.profile], name: p.displayname, avatar: p.avatar_url } : { name: user.name || me, avatar: user.avatar, ...c?.getAccountData(communityEvents.profile as any)?.getContent() });
}
export function readMemberProfile(roomId: string, userId: string, serverId?: string): Profile {
  const c = getMatrixClient(), r = c?.getRoom(roomId), own = state(r, 'm.room.member', userId), server = serverId ? state(c?.getRoom(serverId), 'm.room.member', userId) : {};
  const p = server[communityEvents.profile]?.serverOverride ? server : own;
  return visibleProfileMetadata(normalizeProfile({ ...p[communityEvents.profile], name: serverNicknameForRoom(roomId, userId, serverId) ?? (p.displayname || r?.getMember(userId)?.name || userId), avatar: p.avatar_url }), roomId);
}
async function publishOwnProfile(roomId: string, profile: Profile, override: string, owner = getMatrixClient(), project = false) {
  const checked = await checkProfileMetadataPublication(roomId, profile, owner, project), { client: c, actor: me, membership: old } = checked;
  if (c !== getMatrixClient() || c.getUserId() !== me || c.getRoom(roomId)?.getMyMembership() !== 'join') throw new Error('Your account or room membership changed.');
  // Matrix authenticates self membership updates. An unprivileged user cannot overwrite another user's profile.
  await c.sendStateEvent(roomId, 'm.room.member' as any, { ...old, membership: 'join', displayname: checked.profile.name, avatar_url: checked.profile.avatar, [communityEvents.profile]: { ...checked.profile, serverOverride: override } }, me);
  if (c !== getMatrixClient() || c.getUserId() !== me) throw new Error('Your account changed while the profile was saving.');
  return checked.profile;
}
export async function saveOwnProfile(value: Profile, serverId?: string) {
  const { c, me } = context(serverId), profile = normalizeProfile(value); if (!profile.name.trim()) throw new Error('Enter a display name.');
  if (value.timezone && !profile.timezone) throw new Error('Enter a valid timezone, such as America/New_York.');
  if (value.language && !profile.language) throw new Error('Enter a valid language tag, such as en-US or de.');
  if (profile.fields.length !== (value.fields || []).length) throw new Error('Each custom profile field needs a label and value. Keep at most eight fields.');
  if (profile.links.length !== value.links.length) throw new Error('Profile links must use HTTP or HTTPS and cannot contain a username or password.');
  if (serverId && !c.getRoom(serverId)?.isSpaceRoom()) throw new Error('Choose a server for this profile.');
  if (serverId) { await publishOwnProfile(serverId, profile, serverId, c); return; }
  // Preserve server-specific profiles, including when Synapse updates memberships after a global profile change.
  const overrides = c.getRooms().filter(r => r.getMyMembership() === 'join' && state(r, 'm.room.member', me)[communityEvents.profile]?.serverOverride).map(r => ({ id: r.roomId, profile: readOwnProfile(r.roomId), override: state(r, 'm.room.member', me)[communityEvents.profile].serverOverride as string }));
  const current = () => { if (getMatrixClient() !== c || c.getUserId() !== me) throw new Error('Your account changed. Remaining profile updates were stopped.'); };
  try { current(); await c.setDisplayName(profile.name); current(); await c.setAvatarUrl(profile.avatar); current(); await c.setAccountData(communityEvents.profile as any, profile as any); current(); }
  catch (failure) { throw new Error(`Some account profile changes may have been saved, but the update did not finish. ${(failure as Error).message}`); }
  const overridden = new Set(overrides.map(r => r.id));
  const updates = [...overrides, ...c.getRooms().filter(r => r.getMyMembership() === 'join' && !overridden.has(r.roomId)).map(r => ({ id: r.roomId, profile, override: '' }))];
  let failed = 0, detail = ''; for (let i = 0; i < updates.length; i += 4) { current(); const results = await Promise.allSettled(updates.slice(i, i + 4).map(r => publishOwnProfile(r.id, r.profile, r.override, c, true))); for (const result of results) if (result.status === 'rejected') { failed++; detail ||= result.reason instanceof Error ? result.reason.message : 'The server rejected a profile update.'; } }
  if (failed) throw new Error(`Your account profile was saved, but ${failed} conversation profile update(s) failed. ${detail} Save again to retry.`);
}
export async function resetServerProfile(serverId: string): Promise<Profile> { const { c, room } = context(serverId); if (!room!.isSpaceRoom()) throw new Error('Choose a server for this profile.'); return publishOwnProfile(serverId, readOwnProfile(), '', c, true); }
export function collapsedCategories(serverId: string): string[] { const p = getMatrixClient()?.getAccountData(communityEvents.preferences as any)?.getContent(); const values = record(record(p).collapsed)[serverId]; return Array.isArray(values) ? values.filter(v => typeof v === 'string').slice(0, 100) : []; }
let preferenceQueue: Promise<unknown> = Promise.resolve();
export function setCollapsedCategory(serverId: string, categoryId: string, collapsed: boolean) {
  const { c } = context(); const task = preferenceQueue.catch(() => {}).then(async () => { const old = record(c.getAccountData(communityEvents.preferences as any)?.getContent()), ids = new Set(collapsedCategories(serverId)); collapsed ? ids.add(categoryId) : ids.delete(categoryId); await c.setAccountData(communityEvents.preferences as any, { ...old, collapsed: { ...record(old.collapsed), [serverId]: [...ids] } } as any); }); preferenceQueue = task; return task;
}
export async function uploadProfileImage(blob: Blob) { const { c } = context(); if (!['image/webp', 'image/png', 'image/jpeg'].includes(blob.type) || blob.size > 2 * 1024 * 1024) throw new Error('Use an optimized PNG, JPEG, or WebP image under 2 MB.'); return (await c.uploadContent(blob, { includeFilename: false, type: blob.type })).content_uri; }
export async function profileImageBlob(mxc: string, size = 128, signal?: AbortSignal, height = size): Promise<Blob> {
  const { c } = context(); if (!cleanMxc(mxc)) throw new Error('Invalid profile image.'); const url = authenticatedMatrixMediaUrl(c, mxc, { width: size, height });
  const response = await fetch(url, { signal, cache: 'no-store', headers: { Authorization: 'Bearer ' + c.getAccessToken() }, referrerPolicy: 'no-referrer' });
  return readImageResponse(response, 5 * 1024 * 1024, () => getMatrixClient() === c, signal, type => type.startsWith('image/'));
}
export async function cropProfileImage(file: File, zoom = 1, x = 0.5, y = 0.5, banner = false): Promise<Blob> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, WebP, or GIF image under 10 MB.');
  const bitmap = await createImageBitmap(file); try { if (bitmap.width * bitmap.height > 40_000_000) throw new Error('Choose an image under 40 megapixels.'); const ratio = banner ? 3 : 1, width = Math.min(bitmap.width, bitmap.height * ratio) / Math.max(1, Math.min(4, zoom)), height = width / ratio, canvas = document.createElement('canvas'); canvas.width = banner ? 1200 : 512; canvas.height = banner ? 400 : 512; const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Image editing is unavailable in this browser.'); ctx.drawImage(bitmap, (bitmap.width - width) * Math.max(0, Math.min(1, x)), (bitmap.height - height) * Math.max(0, Math.min(1, y)), width, height, 0, 0, canvas.width, canvas.height); return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not process image.')), 'image/webp', 0.85)); } finally { bitmap.close(); }
}
