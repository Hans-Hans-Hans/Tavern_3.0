import { createClient, Room, MatrixEvent, RoomEvent } from 'matrix-js-sdk';
const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild() { return silent; } };

// Real pinned SDK HTTP/context/timeline models. Only the crypto backend is a
// fixture; native Megolm recovery is exercised by the separate Linux smoke.
export function messageHistoryFixture() {
  const roomId = '!context:local', eventId = '$target/opaque?fragment#id', bodies = new Map(), requests = [];
  const state = { current: true, contextGate: null, pageGate: null, decryptGate: null, failPage: false, missingKey: false, pages: null };
  const encrypted = (id, body, time = 1) => {
    bodies.set(id, { msgtype: 'm.text', body });
    return { event_id: id, room_id: roomId, type: 'm.room.encrypted', sender: '@alice:local', origin_server_ts: time, content: { algorithm: 'm.megolm.v1.aes-sha2', session_id: 'fixture', ciphertext: 'synthetic-fixture-only' } };
  };
  const before = encrypted('$before', 'Before the selected message', 2), target = encrypted(eventId, 'Selected message', 3), after = encrypted('$after', 'After the selected message', 4), live = encrypted('$live', 'Latest conversation message', 10);
  const older = encrypted('$older', 'Earlier historical message', 1), later = encrypted('$later', 'Later historical message', 5);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const client = createClient({ baseUrl: 'https://context-fixture.local', userId: '@me:local', deviceId: 'CONTEXT', accessToken: 'fixture-only', timelineSupport: true,
    logger: silent, fetchFn: async input => {
      const url = new URL(String(input)); requests.push(url);
      if (url.pathname.includes('/context/')) {
        if (state.contextGate) await state.contextGate;
        return json(state.context || { event: target, events_before: [before], events_after: [after], state: [], start: 'b0', end: 'f0' });
      }
      if (url.pathname.endsWith('/messages')) {
        if (state.pageGate) await state.pageGate;
        if (state.failPage) return json({ errcode: 'M_FORBIDDEN', error: 'Fixture history denied' }, 403);
        const from = url.searchParams.get('from'), dir = url.searchParams.get('dir');
        if (state.pages) return json(state.pages(from, dir));
        if (from === 'b0') return json({ chunk: [], start: from, end: 'b1' });
        if (from === 'b1') return json({ chunk: [older], start: from });
        if (from === 'f0') return json({ chunk: [later], start: from, end: 'f1' });
        if (from === 'f1') return json({ chunk: [live], start: from, end: 'f2' });
      }
      throw new Error('Unexpected fixture request');
    } });
  client.supportsThreads = () => false;
  client.decryptEventIfNeeded = async event => {
    if (state.decryptGate) await state.decryptGate;
    if (event.isEncrypted() && !event.getClearContent()) await event.attemptDecryption({ decryptEvent: async () => {
      if (state.missingKey) throw new Error('Fixture key unavailable');
      return { clearEvent: { type: 'm.room.message', content: bodies.get(event.getId()) } };
    } });
  };
  const room = new Room(roomId, client, '@me:local', { timelineSupport: true, pendingEventOrdering: 'chronological' });
  client.store.storeRoom(room); room.updateMyMembership('join');
  const set = room.getUnfilteredTimelineSet(); set.addLiveEvent(new MatrixEvent(live), { addToState: true });
  return { client, room, roomId, eventId, set, state, requests, encrypted, target, before, after, live, current: () => state.current,
    project: events => events.map(event => ({ id: event.getId(), body: event.isDecryptionFailure() ? 'Missing key' : event.getContent().body })),
    listenerCount: () => room.listenerCount(RoomEvent.Timeline) };
}
