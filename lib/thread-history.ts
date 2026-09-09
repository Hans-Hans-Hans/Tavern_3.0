import { Direction, RoomEvent, ThreadEvent, type EventTimeline, type MatrixClient, type MatrixEvent, type Room, type Thread } from 'matrix-js-sdk';
import { resolveJoinedEvent } from './resolve-event';

const initialReads = new WeakMap<MatrixClient, WeakMap<Room, Map<string, Promise<Thread>>>>();
const olderReads = new WeakMap<Thread, { promise: Promise<boolean>; history: ThreadHistoryGraph }>();
const initialTimeout = 20_000;
const unavailable = () => new Error('Thread history did not finish loading. Reconnect your Matrix session and reopen this thread.');
const timelineChanged = () => new Error('The thread timeline changed while loading earlier replies. Reopen the thread.');
export type ThreadHistoryGraph = { timelines: EventTimeline[]; oldest: EventTimeline; cursor: string | null };

/** A null cursor ends one SDK segment, not necessarily the connected history.
 * Follow only reciprocal older links belonging to this exact thread timeline set. */
export function threadHistoryGraph(thread: Thread): ThreadHistoryGraph {
  const set = thread.timelineSet, timelines: EventTimeline[] = [], seen = new Set<EventTimeline>();
  let timeline: EventTimeline | null = set.getLiveTimeline();
  while (timeline) {
    if (seen.has(timeline) || timeline.getTimelineSet() !== set || timeline.getRoomId() !== thread.room.roomId) throw timelineChanged();
    if (timelines.length >= 256) throw new Error('This thread exceeds the 256 connected-timeline discovery limit. The participant list remains incomplete.');
    seen.add(timeline); timelines.push(timeline);
    const older: EventTimeline | null = timeline.getNeighbouringTimeline(Direction.Backward);
    if (older && older.getNeighbouringTimeline(Direction.Forward) !== timeline) throw timelineChanged();
    timeline = older;
  }
  const oldest = timelines[timelines.length - 1];
  if (!oldest) throw timelineChanged();
  const cursor = oldest.getPaginationToken(Direction.Backward);
  if (cursor !== null && cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 8192)) throw new Error('The homeserver returned an invalid thread history cursor. Reopen this thread.');
  return { timelines, oldest, cursor: cursor ?? null };
}

/** Appends within segments and a completed cursor advance are normal. A reset
 * or relink changes the read's scope, even if the live timeline stays the same. */
export function assertThreadHistoryGraph(thread: Thread, previous: ThreadHistoryGraph) {
  const next = threadHistoryGraph(thread);
  if (next.timelines.length !== previous.timelines.length || next.timelines.some((timeline, index) => timeline !== previous.timelines[index])) throw timelineChanged();
}

function scope(client: MatrixClient, room: Room, current: () => boolean, thread?: Thread) {
  if (!current() || client.getRoom(room.roomId) !== room || room.getMyMembership() !== 'join') throw new Error('Your account or room access changed. Reopen the conversation.');
  if (thread && (thread.room !== room || thread.client !== client || room.getThread(thread.id) !== thread)) throw new Error('This thread changed while its history was loading. Reopen the thread.');
}
function validateRoot(room: Room, id: string, event: MatrixEvent) {
  const type = event.getType(), relation = event.getRelation();
  if (event.getId() !== id || event.getRoomId() !== room.roomId || event.isState() || relation?.rel_type === 'm.thread' || relation?.rel_type === 'm.replace' || event.threadRootId && event.threadRootId !== id || type !== 'm.room.message' && !(event.isEncrypted() && (type === 'm.room.encrypted' || event.isDecryptionFailure()))) throw new Error('Choose an original message from this conversation to open its thread.');
}
function pendingFor(client: MatrixClient, room: Room) {
  let rooms = initialReads.get(client); if (!rooms) { rooms = new WeakMap(); initialReads.set(client, rooms); }
  let reads = rooms.get(room); if (!reads) { reads = new Map(); rooms.set(room, reads); }
  return reads;
}

/** createThread owns initialization. Observe its public completion flag and
 * events instead of starting a competing latest-timeline/relations request. */
function initialized(client: MatrixClient, room: Room, thread: Thread, current: () => boolean): Promise<Thread> {
  scope(client, room, current, thread);
  if (thread.initialEventsFetched) return Promise.resolve(thread);
  return new Promise((resolve, reject) => {
    let done = false;
    const clean = () => { clearTimeout(timeout); clearInterval(ownership); thread.off(ThreadEvent.Update, check); thread.off(ThreadEvent.Delete, deleted); room.off(RoomEvent.MyMembership, check); };
    const finish = (error?: Error) => { if (done) return; done = true; clean(); if (error) reject(error); else resolve(thread); };
    const check = () => { try { scope(client, room, current, thread); if (thread.initialEventsFetched) finish(); } catch (error) { finish(error as Error); } };
    const deleted = () => finish(new Error('This thread was removed while its history was loading.'));
    const timeout = setTimeout(() => finish(unavailable()), initialTimeout);
    // Account replacement need not emit another event on the old Room.
    const ownership = setInterval(check, 250);
    thread.on(ThreadEvent.Update, check); thread.on(ThreadEvent.Delete, deleted); room.on(RoomEvent.MyMembership, check);
    check();
  });
}

export async function ensureThreadHistory(client: MatrixClient, room: Room, rootId: string, cachedRoot: MatrixEvent | undefined, current: () => boolean): Promise<Thread> {
  scope(client, room, current);
  if (typeof rootId !== 'string' || !/^\$[^\s\x00-\x1f\x7f]{1,4095}$/.test(rootId)) throw new Error('Choose a valid thread message.');
  const reads = pendingFor(client, room);
  let pending = reads.get(rootId);
  if (!pending) {
    pending = (async () => {
      let thread = room.getThread(rootId);
      if (!thread) {
        const { event } = await resolveJoinedEvent(client, room.roomId, rootId, cachedRoot, current);
        scope(client, room, current); validateRoot(room, rootId, event);
        // A sync may have created the same thread while resolving its root.
        thread = room.getThread(rootId) || room.createThread(rootId, event, [], true);
      }
      scope(client, room, current, thread);
      if (thread.rootEvent) validateRoot(room, rootId, thread.rootEvent);
      await initialized(client, room, thread, current);
      scope(client, room, current, thread);
      if (thread.rootEvent) validateRoot(room, rootId, thread.rootEvent);
      return thread;
    })();
    reads.set(rootId, pending);
    const release = () => { if (reads.get(rootId) === pending) reads.delete(rootId); };
    void pending.then(release, release);
  }
  const thread = await pending;
  scope(client, room, current, thread);
  return thread;
}

export async function readThreadSnapshot(client: MatrixClient, room: Room, rootId: string, cachedRoot: MatrixEvent | undefined, current: () => boolean): Promise<{ events: MatrixEvent[]; assertCurrent: () => void }> {
  const actor = client.getUserId(), device = client.getDeviceId();
  const owned = () => current() && client.getUserId() === actor && client.getDeviceId() === device;
  const thread = await ensureThreadHistory(client, room, rootId, cachedRoot, owned);
  scope(client, room, owned, thread);
  // The SDK retains edits/reactions in its own timeline for aggregation. The
  // message projection will select direct replies after normal decryption.
  const history = threadHistoryGraph(thread), seen = new Set<string>(), events: MatrixEvent[] = [];
  for (const timeline of [...history.timelines].reverse()) for (const event of timeline.getEvents()) {
    const id = event.getId();
    if (event.getRoomId() !== room.roomId || id && seen.has(id)) continue;
    if (id) seen.add(id);
    events.push(event);
  }
  const assertCurrent = () => { scope(client, room, owned, thread); assertThreadHistoryGraph(thread, history); };
  assertCurrent();
  return { events, assertCurrent };
}

export async function readThreadEvents(client: MatrixClient, room: Room, rootId: string, cachedRoot: MatrixEvent | undefined, current: () => boolean): Promise<MatrixEvent[]> {
  const snapshot = await readThreadSnapshot(client, room, rootId, cachedRoot, current);
  snapshot.assertCurrent();
  return snapshot.events;
}

export function threadHistoryHasOlder(client: MatrixClient, room: Room, rootId: string): boolean {
  try { const thread = room.getThread(rootId); if (!thread) return false; scope(client, room, () => true, thread); return thread.initialEventsFetched && threadHistoryGraph(thread).cursor !== null; } catch { return false; }
}

export async function loadOlderThreadHistory(client: MatrixClient, room: Room, rootId: string, cachedRoot: MatrixEvent | undefined, current: () => boolean): Promise<boolean> {
  const thread = await ensureThreadHistory(client, room, rootId, cachedRoot, current);
  scope(client, room, current, thread);
  let request = olderReads.get(thread);
  if (!request) {
    const history = threadHistoryGraph(thread);
    if (history.cursor === null) return false;
    request = { promise: client.paginateEventTimeline(history.oldest, { backwards: true, limit: 50 }), history };
    olderReads.set(thread, request);
    const release = () => { if (olderReads.get(thread) === request) olderReads.delete(thread); };
    void request.promise.then(release, release);
  }
  assertThreadHistoryGraph(thread, request.history);
  const hasMore = await request.promise;
  scope(client, room, current, thread);
  assertThreadHistoryGraph(thread, request.history);
  return hasMore;
}
