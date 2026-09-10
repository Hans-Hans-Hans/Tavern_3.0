import type { MatrixClient } from 'matrix-js-sdk';

export type DirectMessageMap = Record<string, string[]>;
export function directRoomId(value: unknown): value is string {
  return typeof value === 'string' && new TextEncoder().encode(value).length <= 255
    && (/^![^\s/\\?#\x00-\x1f\x7f]+:[^\s/\\?#\x00-\x1f\x7f]+$/.test(value) || /^![A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value));
}
export function directMessageMap(value: unknown): DirectMessageMap {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.entries(value).every(([peer, rooms]) =>
    /^@[^\s:]+:[^\s]+$/.test(peer) && Array.isArray(rooms) && rooms.every(directRoomId))) {
    throw new Error('Your saved Messages list is invalid. It has been kept unchanged.');
  }
  return Object.fromEntries(Object.entries(value).map(([peer, rooms]) => [peer, [...rooms]]));
}
export function addDirectMessage(value: unknown, peers: readonly string[], roomId: string): DirectMessageMap {
  if (!directRoomId(roomId)) throw new Error('The server did not confirm a valid conversation ID.');
  const next = directMessageMap(value);
  for (const peer of peers) {
    if (!/^@[^\s:]+:[^\s]+$/.test(peer)) throw new Error('Use a full Matrix ID for each participant.');
    next[peer] = [...new Set([...(next[peer] || []), roomId])];
  }
  return next;
}
/** The SDK's getAccountDataFromServer uses its local cache after initial sync.
 * Read the native endpoint explicitly before merging or confirming persistence.
 * Matrix account data has no cross-device compare-and-swap operation. */
export async function readDirectMessageMap(client: MatrixClient, current: () => void): Promise<DirectMessageMap> {
  current(); let value: unknown;
  try { value = await client.http.authedRequest('GET' as any, '/user/' + encodeURIComponent(client.getUserId()!) + '/account_data/m.direct'); }
  catch (error) { current(); if ((error as any)?.errcode !== 'M_NOT_FOUND') throw error; value = {}; }
  current(); return directMessageMap(value);
}
