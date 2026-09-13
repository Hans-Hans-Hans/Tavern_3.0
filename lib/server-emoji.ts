import { accountArtworkOwner } from './api';
import { getMatrixClient } from './matrix';
import { cleanMxc, cropProfileImage, uploadProfileImage } from './community';
export const serverEmojiEvent = 'io.tavern.emoji';
export type ServerEmoji = { name: string; uri: string; creator: string; aliases?: string[] };
export function parseServerEmoji(content: unknown): ServerEmoji[] { const emojis = (content as any)?.emoji; if (!Array.isArray(emojis)) return []; const seen = new Set<string>(); return emojis.slice(0, 100).flatMap(raw => { const name = typeof raw?.name === 'string' ? raw.name : '', uri = cleanMxc(raw?.uri); if (!/^[a-z0-9_-]{1,32}$/.test(name) || seen.has(name) || !uri) return []; seen.add(name); const aliases = Array.isArray(raw.aliases) ? [...new Set(raw.aliases.filter((value: unknown) => typeof value === 'string' && /^[a-z0-9_-]{1,32}$/.test(value) && value !== name))].slice(0, 8) as string[] : []; return [{ name, uri, creator: typeof raw?.creator === 'string' ? raw.creator.slice(0, 255) : '', ...(aliases.length ? { aliases } : {}) }]; }); }
export function readServerEmoji(serverId?: string) { return serverId ? parseServerEmoji(getMatrixClient()?.getRoom(serverId)?.currentState.getStateEvents(serverEmojiEvent, '')?.getContent()) : []; }
export function canManageServerEmoji(serverId: string) { const c = getMatrixClient(), me = c?.getUserId(), room = c?.getRoom(serverId); return !!(me && room?.isSpaceRoom() && room.getMyMembership() === 'join' && room.currentState.maySendStateEvent(serverEmojiEvent, me)); }
type EmojiEditOptions = { isCurrent?: () => boolean; expectedUri?: string };
const emojiQueues = new WeakMap<object, Map<string, Promise<unknown>>>();

function emojiOwner(serverId: string, options: EmojiEditOptions) {
  const client = getMatrixClient(), user = client?.getUserId(), device = client?.getDeviceId(), base = client?.getHomeserverUrl();
  const room = client?.getRoom(serverId), account = accountArtworkOwner();
  const check = () => {
    if (!client || !user || getMatrixClient() !== client || accountArtworkOwner() !== account
      || client.getUserId() !== user || client.getDeviceId() !== device || client.getHomeserverUrl() !== base
      || client.getRoom(serverId) !== room || options.isCurrent?.() === false)
      throw new Error('This emoji editor is no longer current. Reopen server settings.');
    if (!room?.isSpaceRoom() || room.getMyMembership() !== 'join' || !room.currentState.maySendStateEvent(serverEmojiEvent, user))
      throw new Error('You no longer have permission to manage server emoji.');
  };
  check();
  return { client: client!, user: user!, check };
}

async function mutateEmoji(serverId: string, owner: ReturnType<typeof emojiOwner>, fn: (old: ServerEmoji[]) => ServerEmoji[]) {
  const { client, check } = owner;
  let queues = emojiQueues.get(client);
  if (!queues) { queues = new Map(); emojiQueues.set(client, queues); }
  const queue = queues;
  const task = (queue.get(serverId) || Promise.resolve()).catch(() => {}).then(async () => {
    check();
    let old: ServerEmoji[] = [];
    try { old = parseServerEmoji(await client.getStateEvent(serverId, serverEmojiEvent as any, '')); }
    catch (error) { if ((error as any).errcode !== 'M_NOT_FOUND') throw error; }
    check();
    const emoji = fn(old);
    await client.sendStateEvent(serverId, serverEmojiEvent as any, { version: 1, emoji }, '');
    // The state write was acknowledged. Closing a form afterwards must not
    // turn that accepted write into a reported failure or an automatic retry.
  });
  queue.set(serverId, task);
  try { await task; } finally { if (queue.get(serverId) === task) queue.delete(serverId); }
}

function emojiName(value: string) {
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new Error('Emoji names use 1–32 lowercase letters, numbers, underscores, or hyphens.');
  return name;
}
function uniqueEmoji(old: ServerEmoji[], name: string) {
  if (old.length >= 100 || old.some(emoji => emoji.name === name || emoji.aliases?.includes(name)))
    throw new Error('That name is already used, or the emoji collection is full.');
}
function unchangedEmoji(old: ServerEmoji[], name: string, options: EmojiEditOptions) {
  const emoji = old.find(item => item.name === name);
  if (!emoji || options.expectedUri && emoji.uri !== options.expectedUri) throw new Error('This emoji changed or was removed. Close this dialog and review the current list.');
  return emoji;
}
export async function addServerEmoji(serverId: string, value: string, file: File, options: EmojiEditOptions = {}) {
  const name = emojiName(value), owner = emojiOwner(serverId, options);
  uniqueEmoji(readServerEmoji(serverId), name);
  const cropped = await cropProfileImage(file);
  owner.check();
  const uri = cleanMxc(await uploadProfileImage(cropped));
  owner.check();
  if (!uri) throw new Error('The image upload did not return a valid media reference.');
  return mutateEmoji(serverId, owner, old => {
    uniqueEmoji(old, name);
    return [...old, { name, uri, creator: owner.user }];
  });
}
export async function removeServerEmoji(serverId: string, name: string, options: EmojiEditOptions = {}) {
  return mutateEmoji(serverId, emojiOwner(serverId, options), old => {
    unchangedEmoji(old, name, options);
    return old.filter(emoji => emoji.name !== name);
  });
}
export async function renameServerEmoji(serverId: string, name: string, replacement: string, options: EmojiEditOptions = {}) {
  const next = emojiName(replacement);
  return mutateEmoji(serverId, emojiOwner(serverId, options), old => {
    unchangedEmoji(old, name, options);
    if (next !== name && old.some(emoji => emoji.name !== name && (emoji.name === next || emoji.aliases?.includes(next)))) throw new Error('That emoji name is already used.');
    return old.map(emoji => emoji.name === name ? { ...emoji, name: next, aliases: [...new Set([name, ...(emoji.aliases || [])])].filter(alias => alias !== next).slice(0, 8) } : emoji);
  });
}
export function filterServerEmoji(emojis: ServerEmoji[], query: string) {
  const needle = query.trim().toLowerCase().replace(/^:|:$/g, '');
  return emojis.filter(emoji => [emoji.name, ...(emoji.aliases || [])].some(name => name.includes(needle)));
}
export function tokenizeServerEmoji(text: string, emojis: ServerEmoji[]): ({ text: string } | { emoji: ServerEmoji })[] {
  const known = new Map(emojis.map(e => [e.name, e])), parts: ({ text: string } | { emoji: ServerEmoji })[] = []; for (const emoji of emojis) for (const alias of emoji.aliases || []) if (!known.has(alias)) known.set(alias, emoji); let at = 0;
  for (const match of text.matchAll(/:([a-z0-9_-]{1,32}):/g)) { const found = known.get(match[1]); if (!found) continue; if (match.index! > at) parts.push({ text: text.slice(at, match.index) }); parts.push({ emoji: found }); at = match.index! + match[0].length; }
  if (at < text.length || !parts.length) parts.push({ text: text.slice(at) }); return parts;
}
export function serverEmojiHtml(text: string, emojis: ServerEmoji[]): string | undefined { const parts = tokenizeServerEmoji(text, emojis); if (!parts.some(p => 'emoji' in p)) return undefined; const escape = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!)); return parts.map(p => 'text' in p ? escape(p.text).replace(/\n/g, '<br>') : `<img data-mx-emoticon src="${escape(p.emoji.uri)}" alt=":${escape(p.emoji.name)}:" title=":${escape(p.emoji.name)}:" width="24" height="24">`).join(''); }
