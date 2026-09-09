import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';

/** Global caches must never turn an event from another room into a local event. */
export async function resolveJoinedEvent(client: MatrixClient, roomId: string, eventId: string, cached: MatrixEvent | undefined, stillOwned: () => boolean) {
  const room = client.getRoom(roomId);
  const check = () => { if (!stillOwned()) throw new Error('Your account changed. Reopen this message.'); if (!room || client.getRoom(roomId) !== room || room.getMyMembership() !== 'join') throw new Error('Join this conversation before opening it.'); };
  check();
  const local = room!.findEventById(eventId);
  let event = [local, cached].find(value => value?.getId() === eventId && value.getRoomId() === roomId);
  if (!event) {
    const raw = await client.fetchRoomEvent(roomId, eventId); check();
    if (raw.event_id !== eventId || raw.room_id !== undefined && raw.room_id !== roomId) throw new Error('This message does not belong to the requested conversation.');
    event = client.getEventMapper()({ ...raw, room_id: roomId });
  }
  if (event.isEncrypted()) await client.decryptEventIfNeeded(event).catch(() => {});
  check();
  if (event.getRoomId() !== roomId || event.getId() !== eventId) throw new Error('This message does not belong to the requested conversation.');
  return { room: room!, event };
}
