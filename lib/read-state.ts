import type { ClientEvent, MatrixClient, MatrixEvent, ReceiptType, Room, RoomEvent } from 'matrix-js-sdk';

export const navigationAccountKey = 'io.tavern.navigation';
const unreadRevisions = new WeakMap<MatrixClient, Map<string, number>>();
export function navigationUnreadRevision(client: MatrixClient, roomId: string) { return unreadRevisions.get(client)?.get(roomId) || 0; }
/** Record intent immediately, including a newer marker waiting for the account-data queue. */
export function noteNavigationUnreadChange(client: MatrixClient, roomId: string) {
  let revisions = unreadRevisions.get(client); if (!revisions) unreadRevisions.set(client, revisions = new Map());
  revisions.set(roomId, navigationUnreadRevision(client, roomId) + 1);
}
export function navigationLists(value: unknown): { favorites: string[]; unread: string[] } {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const list = (v: unknown) => Array.isArray(v) ? [...new Set(v.filter((id): id is string => typeof id === 'string'))].slice(0, 1000) : [];
  return { favorites: list(data.favorites), unread: list(data.unread) };
}
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
/** Highlights are Matrix push-rule counts (including thread counts), not a plaintext scan. */
export function roomReadCounts(room: Pick<Room, 'getUnreadNotificationCount'>) {
  return { unread: count(room.getUnreadNotificationCount()), mentions: count(room.getUnreadNotificationCount('highlight' as any)) };
}
/** Aggregate only currently joined children also present in the caller's visible
 * conversation inventory. Counts come from native push rules, never message scans. */
export function serverReadCounts(client: Pick<MatrixClient, 'getRoom'>, serverId: string, visibleRoomIds: ReadonlySet<string>, muted: ReadonlySet<string>, manualUnread: ReadonlySet<string>) {
  const result = { unread: 0, mentions: 0, manual: false }, server = client.getRoom(serverId);
  if (!server?.isSpaceRoom() || server.getMyMembership() !== 'join') return result;
  const seen = new Set<string>();
  for (const event of server.currentState.getStateEvents('m.space.child' as any)) {
    const id = event.getStateKey(), via = event.getContent().via;
    if (!id || seen.has(id) || !visibleRoomIds.has(id) || muted.has(id) || !Array.isArray(via) || !via.length) continue;
    seen.add(id); const room = client.getRoom(id);
    if (!room || room.isSpaceRoom() || room.getMyMembership() !== 'join') continue;
    const counts = roomReadCounts(room);
    result.unread = Math.min(Number.MAX_SAFE_INTEGER, result.unread + counts.unread);
    result.mentions = Math.min(Number.MAX_SAFE_INTEGER, result.mentions + counts.mentions);
    result.manual ||= manualUnread.has(id);
  }
  return result;
}
/** SDK42 does not re-emit this room event on MatrixClient. */
export function watchRoomReadCounts(client: MatrixClient, update: () => void) {
  const rooms = new Map<string, Room>();
  const detach = (roomId: string) => { rooms.get(roomId)?.off('Room.UnreadNotifications' as RoomEvent.UnreadNotifications, update); rooms.delete(roomId); };
  const attach = (room: Room) => { if (rooms.get(room.roomId) !== room) { detach(room.roomId); rooms.set(room.roomId, room); room.on('Room.UnreadNotifications' as RoomEvent.UnreadNotifications, update); } };
  client.getRooms().forEach(attach); client.on('Room' as ClientEvent.Room, attach); client.on('deleteRoom' as ClientEvent.DeleteRoom, detach);
  return () => { client.off('Room' as ClientEvent.Room, attach); client.off('deleteRoom' as ClientEvent.DeleteRoom, detach); [...rooms.keys()].forEach(detach); };
}
export type MarkReadResult = {
  marked: string[];
  skipped: { roomId: string; reason: string }[];
  failed: { roomId: string; reason: string }[];
  markerError?: string;
};
export type ReadStateOwner = {
  client: MatrixClient;
  current: () => boolean;
  /** Must merge fresh native account data through the shared owner-bound queue. */
  mutateAccountData: (key: string, update: (old: unknown) => unknown, validate: () => void) => Promise<unknown>;
};

function latestConfirmed(room: Room): MatrixEvent | undefined {
  // Match the SDK's last-live-event ordering, but exclude pending local sends.
  // Neither this projection nor marking read paginates or resolves an event.
  const tails = [room.getLiveTimeline().getEvents(), ...room.getThreads().map(thread => thread.liveTimeline.getEvents())];
  return tails.map(events => [...events].reverse().find(event => !!event.getId() && !event.status && event.getRoomId() === room.roomId && !room.hasPendingEvent(event.getId()!)))
    .filter((event): event is MatrixEvent => !!event)
    .reduce<MatrixEvent | undefined>((last, event) => !last || event.getTs() > last.getTs() ? event : last, undefined);
}

export async function markRoomsRead(owner: ReadStateOwner, roomIds?: readonly string[]): Promise<MarkReadResult> {
  const { client } = owner, actor = client.getUserId();
  const current = () => { if (!actor || !owner.current() || client.getUserId() !== actor) throw new Error('Your account changed. Run this action again from your current account.'); };
  current();
  const requested = roomIds ? new Set(roomIds) : null;
  const manual = new Set(navigationLists(client.getAccountData(navigationAccountKey as any)?.getContent()).unread);
  const captured = client.getRooms().filter(room => room.getMyMembership() === 'join' && !room.isSpaceRoom() && (requested ? requested.has(room.roomId) : manual.has(room.roomId) || roomReadCounts(room).unread > 0 || roomReadCounts(room).mentions > 0))
    .map(room => ({ room, event: latestConfirmed(room), manual: manual.has(room.roomId), revision: navigationUnreadRevision(client, room.roomId) }));
  const result: MarkReadResult = { marked: [], skipped: [], failed: [] };
  for (const { room, event } of captured) {
    current();
    if (client.getRoom(room.roomId) !== room || room.getMyMembership() !== 'join') { result.skipped.push({ roomId: room.roomId, reason: 'You are no longer joined.' }); continue; }
    if (!event) { result.skipped.push({ roomId: room.roomId, reason: 'No confirmed event is loaded on this device.' }); continue; }
    try {
      // Explicit unthreaded PRIVATE receipts cover room + native thread notifications.
      // The captured event never moves forward to acknowledge arrivals during this batch.
      await client.sendReadReceipt(event, 'm.read.private' as ReceiptType, true);
      current();
      if (client.getRoom(room.roomId) !== room || room.getMyMembership() !== 'join') { result.skipped.push({ roomId: room.roomId, reason: 'Your membership changed while marking read.' }); continue; }
      result.marked.push(room.roomId);
    } catch (error) { current(); result.failed.push({ roomId: room.roomId, reason: error instanceof Error ? error.message : 'The homeserver did not confirm the receipt.' }); }
  }
  const marked = new Set(result.marked), candidates = captured.filter(item => item.manual && marked.has(item.room.roomId));
  if (candidates.length) {
    try {
      await owner.mutateAccountData(navigationAccountKey, old => {
        current(); const value = old && typeof old === 'object' && !Array.isArray(old) ? old as Record<string, unknown> : {};
        const clear = new Set(candidates.filter(item => client.getRoom(item.room.roomId) === item.room && item.room.getMyMembership() === 'join' && navigationUnreadRevision(client, item.room.roomId) === item.revision).map(item => item.room.roomId));
        return { ...value, ...navigationLists(value), unread: navigationLists(value).unread.filter(id => !clear.has(id)) };
      }, current);
      current();
    } catch (error) { current(); result.markerError = error instanceof Error ? error.message : 'Unread markers could not be saved.'; }
  }
  return result;
}

export function markReadSummary(result: MarkReadResult) {
  const pieces = [result.marked.length ? `Marked ${result.marked.length} conversation${result.marked.length === 1 ? '' : 's'} read through the events loaded when you started.` : 'No conversation was marked read.'];
  if (result.failed.length) pieces.push(`${result.failed.length} receipt${result.failed.length === 1 ? '' : 's'} failed; retry to update them.`);
  if (result.skipped.length) pieces.push(`${result.skipped.length} conversation${result.skipped.length === 1 ? ' was' : 's were'} skipped because no confirmed event was loaded or membership changed.`);
  if (result.markerError) pieces.push('Receipts were sent, but manual unread markers could not be saved. Retry to clear them.');
  return pieces.join(' ');
}
