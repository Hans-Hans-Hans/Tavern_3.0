import { createClient, Room, MatrixEvent, Thread, FeatureSupport } from 'matrix-js-sdk';

/** Actual SDK Room/Thread/timeline and HTTP parsing. The decryption backend is
 * deliberately a fixture; these tests validate encrypted wire-event loading,
 * not cryptography or external Synapse access. */
export function threadHistoryFixture({ empty = false, rootId = '$historical/root?opaque#id' } = {}) {
  Thread.setServerSideSupport(FeatureSupport.Stable);
  const roomId = '!history:local', bodies = new Map(), requests = [], state = { current: true, rootGate: null, pageGate: null, failPage: false };
  function encrypted(id, body, parent, timestamp) {
    const relation = parent ? { 'm.relates_to': { rel_type: 'm.thread', event_id: parent, 'm.in_reply_to': { event_id: parent }, is_falling_back: true } } : {};
    bodies.set(id, { msgtype: 'm.text', body, ...relation });
    return { event_id: id, room_id: roomId, sender: '@alice:local', origin_server_ts: timestamp, type: 'm.room.encrypted', content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'synthetic-fixture-only', session_id: 'fixture-session', ...relation } };
  }
  const first = encrypted('$first', 'First historical encrypted reply', rootId, 2), second = encrypted('$second', 'Second historical encrypted reply', rootId, 3), latest = encrypted('$latest', 'Latest encrypted reply', rootId, 4);
  const rawRoot = encrypted(rootId, 'Historical root outside the live room timeline', undefined, 1);
  if (!empty) rawRoot.unsigned = { 'm.relations': { 'm.thread': { count: 3, latest_event: latest, current_user_participated: false } } };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const client = createClient({ baseUrl: 'https://history-fixture.local', userId: '@me:local', accessToken: 'fixture-only', timelineSupport: true, fetchFn: async target => {
    const url = new URL(String(target)); requests.push(url);
    if (url.pathname.includes('/event/')) { if (state.rootGate) await state.rootGate; return response(rawRoot); }
    if (url.pathname.includes('/relations/')) {
      if (state.pageGate) await state.pageGate;
      if (state.failPage) return response({ errcode: 'M_FORBIDDEN', error: 'History access was denied' }, 403);
      if (state.historyPages && url.searchParams.get('from')) return response(state.historyPages(url.searchParams.get('from')));
      // A message-only filter would exclude all three encrypted wire events.
      if (url.pathname.endsWith('/m.room.message')) return response({ chunk: [] });
      return response(empty ? { chunk: [] } : url.searchParams.get('from') ? { chunk: [second, first] } : { chunk: [latest], next_batch: 'older-replies' });
    }
    throw new Error('Unexpected thread fixture HTTP request: ' + url.pathname);
  } });
  client.supportsThreads = () => true;
  client.canSupport.set('RelationsRecursion', 0); // Stable: the SDK need not make separate edit lookups.
  client.decryptEventIfNeeded = async event => {
    if (event.isEncrypted() && !event.getClearContent()) await event.attemptDecryption({ decryptEvent: async () => ({ clearEvent: { type: 'm.room.message', content: bodies.get(event.getId()) || { msgtype: 'm.text', body: 'Fixture event' } } }) });
  };
  const room = new Room(roomId, client, '@me:local', { pendingEventOrdering: 'chronological' }); client.store.storeRoom(room); room.updateMyMembership('join');
  const root = new MatrixEvent(rawRoot);
  return { client, room, root, rootId, requests, state, first, second, latest, rawRoot, current: () => state.current };
}
