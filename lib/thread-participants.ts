import { Thread, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { assertThreadHistoryGraph, ensureThreadHistory, loadOlderThreadHistory, threadHistoryGraph } from './thread-history';

export type ThreadParticipantSnapshot = { userIds: string[]; messages: number; pages: number; complete: boolean; supported: boolean };
export type ThreadParticipantOptions = { signal?: AbortSignal; onProgress?: (value: ThreadParticipantSnapshot) => void };
const pageLimit = 20, pageTimeout = 20_000, eventLimit = 20_000, participantLimit = 5_000;
const changed = () => new Error('Your account or thread access changed. Reopen the thread.');
const aborted = () => new DOMException('Participant discovery stopped. The current list may be incomplete.', 'AbortError');

function guard(client: MatrixClient, room: Room, current: () => boolean, thread?: Thread) {
  if (!current() || client.getRoom(room.roomId) !== room || room.getMyMembership() !== 'join') throw changed();
  if (thread && (thread.client !== client || thread.room !== room || room.getThread(thread.id) !== thread)) throw changed();
}
function cursor(thread: Thread) {
  return threadHistoryGraph(thread).cursor;
}
function collect(room: Room, thread: Thread, pages: number): ThreadParticipantSnapshot {
  const history = threadHistoryGraph(thread);
  if (history.timelines.reduce((total, timeline) => total + timeline.getEvents().length, 0) > eventLimit) throw new Error('This thread exceeds the 20,000 loaded-event discovery limit. The participant list remains incomplete.');
  const users = new Set<string>(), seen = new Set<string>();
  const inspect = (event: MatrixEvent) => {
    const id = event.getId(), sender = event.getSender(), type = event.getWireType(), relation = event.getRelation();
    if (!id || seen.has(id) || event.status || event.isState() || event.isRedacted() || event.getRoomId() !== room.roomId
      || !sender || !/^@[^\s\x00-\x1f\x7f]+:[^\s\x00-\x1f\x7f]+$/.test(sender)
      || type !== 'm.room.message' && type !== 'm.room.encrypted') return;
    if (id === thread.id ? relation?.rel_type === 'm.thread' || relation?.rel_type === 'm.replace' : relation?.rel_type !== 'm.thread' || relation.event_id !== thread.id) return;
    seen.add(id); users.add(sender);
    if (users.size > participantLimit) throw new Error('This thread exceeds the 5,000 participant discovery limit. The participant list remains incomplete.');
  };
  if (thread.rootEvent) inspect(thread.rootEvent);
  for (const timeline of history.timelines) for (const event of timeline.getEvents()) inspect(event);
  const supported = !!Thread.hasServerSideSupport && thread.client.supportsThreads();
  return { userIds: [...users].sort(), messages: seen.size, pages, supported, complete: supported && thread.initialEventsFetched && history.cursor === null };
}

/** A read-only projection of native wire metadata; no plaintext or new index. */
export function loadedThreadParticipants(client: MatrixClient, room: Room, rootId: string, current: () => boolean): ThreadParticipantSnapshot {
  guard(client, room, current);
  const thread = room.getThread(rootId);
  if (!thread) return { userIds: [], messages: 0, pages: 0, complete: false, supported: !!Thread.hasServerSideSupport && client.supportsThreads() };
  guard(client, room, current, thread);
  return collect(room, thread, 0);
}

// Pagination belongs to the SDK and is shared with the ordinary history button.
// Stop observing promptly on cancellation/ownership loss without aborting a
// shared SDK request used by another reader. Never publish its late result.
function waitForPage<T>(read: () => Promise<T>, validate: () => void, signal?: AbortSignal): Promise<T> {
  validate(); if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown, value?: T) => {
      if (done) return; done = true; clearTimeout(timeout); clearInterval(ownership); signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(value!);
    };
    const cancel = () => finish(aborted());
    const check = () => { try { validate(); } catch (error) { finish(error); } };
    const timeout = setTimeout(() => finish(new Error('Participant discovery timed out. The current list may be incomplete; retry when the homeserver responds.')), pageTimeout);
    const ownership = setInterval(check, 250);
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { validate(); if (signal?.aborted) throw aborted(); return read(); }).then(value => {
      try { validate(); if (signal?.aborted) throw aborted(); finish(undefined, value); } catch (error) { finish(error); }
    }, error => finish(error));
  });
}

export async function discoverThreadParticipants(client: MatrixClient, room: Room, rootId: string, cachedRoot: MatrixEvent | undefined, current: () => boolean, options: ThreadParticipantOptions = {}): Promise<ThreadParticipantSnapshot> {
  const actor = client.getUserId(), device = client.getDeviceId();
  const owned = () => current() && client.getUserId() === actor && client.getDeviceId() === device;
  const validate = () => guard(client, room, owned);
  validate();
  const thread = await waitForPage(() => ensureThreadHistory(client, room, rootId, cachedRoot, owned), validate, options.signal);
  const history = threadHistoryGraph(thread);
  const live = () => { guard(client, room, owned, thread); assertThreadHistoryGraph(thread, history); };
  const progress = (pages: number) => { live(); if (options.signal?.aborted) throw aborted(); const result = collect(room, thread, pages); options.onProgress?.(result); live(); if (options.signal?.aborted) throw aborted(); return result; };
  let result = progress(0);
  if (!result.supported) throw new Error('This homeserver does not support historical thread discovery. Only loaded authors can be listed.');
  const seen = new Set<string>();
  for (let pages = 0; !result.complete && pages < pageLimit; pages++) {
    live(); const before = cursor(thread)!;
    if (seen.has(before)) throw new Error('Thread history stopped advancing. The participant list remains incomplete.');
    seen.add(before);
    const more = await waitForPage(() => loadOlderThreadHistory(client, room, rootId, cachedRoot, owned), live, options.signal);
    live(); const after = cursor(thread);
    if (after !== null && (after === before || seen.has(after)) || more !== (after !== null)) throw new Error('Thread history stopped advancing. The participant list remains incomplete.');
    // An empty native page may still advance its cursor to older authors.
    result = progress(pages + 1);
  }
  return result;
}
