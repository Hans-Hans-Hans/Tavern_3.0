import type { MatrixClient, Room } from 'matrix-js-sdk';
import { paletteMatchScore } from './palette-search';

export type SearchCategory = 'all' | 'messages' | 'files' | 'people' | 'channels' | 'servers';
export type SearchPlace = { kind: 'channel' | 'server'; id: string; roomId: string; name: string; detail: string };
export type SearchPerson = { kind: 'person'; id: string; userId: string; roomId: string; name: string; detail: string; keywords: string };
export type SearchInventoryResult = SearchPlace | SearchPerson;
export const searchInventoryLimits = { rooms: 2000, members: 5000, page: 20 } as const;
const changed = () => new Error('Your account or search scope changed. Reopen search.');
const label = (value: unknown, fallback: string) => typeof value === 'string' && value ? value.slice(0, 512) : fallback;

/** Captures only joined SDK rooms and already loaded members. This never asks
 * the homeserver for a directory or loads a room's missing membership/history. */
export function captureSearchInventory(client: MatrixClient, currentOwner: () => boolean, roomIds?: string[]) {
  const actor = client.getUserId(), device = client.getDeviceId(), allowed = roomIds ? new Set(roomIds) : null;
  const rooms = new Map<string, Room>(), items: SearchInventoryResult[] = [], people = new Map<string, SearchPerson>();
  let truncated = false, examinedMembers = 0;
  const assertCurrent = () => { if (!currentOwner() || client.getUserId() !== actor || client.getDeviceId() !== device) throw changed(); };
  assertCurrent();
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== 'join' || allowed && !allowed.has(room.roomId)) continue;
    if (rooms.size >= searchInventoryLimits.rooms) { truncated = true; break; }
    rooms.set(room.roomId, room);
    items.push({ kind: room.isSpaceRoom() ? 'server' : 'channel', id: room.roomId, roomId: room.roomId,
      name: label(room.name, room.roomId), detail: room.roomId });
    if (examinedMembers >= searchInventoryLimits.members) { truncated = true; continue; }
    for (const member of room.getJoinedMembers()) {
      if (++examinedMembers > searchInventoryLimits.members) { truncated = true; break; }
      if (!member.userId || member.userId === actor || member.membership !== 'join' || client.getIgnoredUsers().includes(member.userId)) continue;
      const name = label(member.name, member.userId), existing = people.get(member.userId);
      if (existing) existing.keywords = (existing.keywords + ' ' + name).slice(0, 1200);
      else people.set(member.userId, { kind: 'person', id: member.userId, userId: member.userId, roomId: room.roomId,
        name, detail: member.userId, keywords: (member.userId + ' ' + name).slice(0, 1200) });
    }
  }
  items.push(...people.values());
  function roomCurrent(id: string) { const room = rooms.get(id); return !!room && client.getRoom(id) === room && room.getMyMembership() === 'join'; }
  function accessible(item: SearchInventoryResult) {
    if (!currentOwner() || client.getUserId() !== actor || client.getDeviceId() !== device || !roomCurrent(item.roomId)) return false;
    return item.kind !== 'person' || !client.getIgnoredUsers().includes(item.userId) && rooms.get(item.roomId)?.getMember(item.userId)?.membership === 'join';
  }
  function assertResult(item: SearchInventoryResult) { assertCurrent(); if (!accessible(item)) throw new Error('This result is no longer available in your joined rooms. Search again.'); }
  function assertRoom(roomId: string) { assertCurrent(); if (!roomCurrent(roomId)) throw new Error('You no longer have the same joined conversation open. Search again.'); }
  function search(query: string, kind: SearchCategory, offset = 0) {
    assertCurrent();
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > searchInventoryLimits.rooms + searchInventoryLimits.members) throw new Error('Start a new inventory search.');
    // Message operators are never guessed as directory/profile constraints.
    const metadataQuery = /(?:^|\s)(?:from|in|before|after|has|mentions):/i.test(query) ? null : query.trim().replace(/^[#@]/, '').replace(/"/g, '');
    const matches = metadataQuery === null ? [] : items.filter(item => accessible(item) && (kind === 'all' || kind === 'people' && item.kind === 'person' || kind === 'channels' && item.kind === 'channel' || kind === 'servers' && item.kind === 'server'))
      .map(item => ({ item, score: paletteMatchScore(item.kind === 'person' ? item.keywords : item.name + ' ' + item.detail, metadataQuery) }))
      .filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
    const page = matches.slice(offset, offset + searchInventoryLimits.page).map(row => row.item);
    return { items: page, nextOffset: offset + page.length < matches.length ? offset + page.length : null, matched: matches.length, truncated };
  }
  return { client, actor, device, rooms, assertCurrent, assertRoom, assertResult, accessible, search, truncated };
}
export type SearchInventory = ReturnType<typeof captureSearchInventory>;
