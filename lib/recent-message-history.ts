import { Direction, type EventTimeline, type MatrixClient, type Room } from 'matrix-js-sdk';

type Entry = { timeline: EventTimeline; task?: Promise<void>; finished: boolean };
const entries = new WeakMap<MatrixClient, WeakMap<Room, Entry>>();

/** The initial sync window can contain only call, membership or reaction events.
 * For the selected joined room, look for a visible message in at most three
 * additional pages. This never scans all rooms or removes undecryptable rows. */
export async function recentMessageHistory<T>(client: MatrixClient, room: Room, current: () => boolean, read: () => Promise<T[]>): Promise<T[]> {
  const actor = client.getUserId(), device = client.getDeviceId(), base = client.getHomeserverUrl(), timeline = room.getLiveTimeline();
  const check = () => {
    if (!current() || client.getUserId() !== actor || client.getDeviceId() !== device || client.getHomeserverUrl() !== base || client.getRoom(room.roomId) !== room || room.getMyMembership() !== 'join' || room.getLiveTimeline() !== timeline) throw new Error('Your account or conversation changed. Reopen the conversation.');
  };
  check();
  let rooms = entries.get(client); if (!rooms) { rooms = new WeakMap(); entries.set(client, rooms); }
  let entry = rooms.get(room);
  if (!entry || entry.timeline !== timeline) { entry = { timeline, finished: false }; rooms.set(room, entry); }
  const initial = await read(); check();
  if (initial.length || entry.finished) return initial;
  if (!entry.task) {
    const owned = entry;
    owned.task = (async () => {
      const seen = new Set<string>();
      try {
        for (let page = 0; page < 3; page++) {
          check();
          const token = timeline.getPaginationToken(Direction.Backward);
          if (!token || typeof token !== 'string' || token.length > 8192 || seen.has(token)) break;
          seen.add(token);
          await client.scrollback(room, 100); check();
          const messages = await read(); check();
          if (messages.length) break;
        }
      } finally { owned.finished = true; }
    })();
  }
  // The SDK owns its request and retry lifecycle. Keep one shared read in flight
  // even if this view times out; never start parallel pagination after timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([entry.task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Recent history is taking longer to load. Use Load earlier messages to continue.')), 20000); })]); }
  finally { clearTimeout(timer); }
  check(); const result = await read(); check(); return result;
}
