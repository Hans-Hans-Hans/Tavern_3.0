import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as sdk from 'matrix-js-sdk';
import { loadTs } from './load-ts.mjs';
import { threadHistoryFixture } from './fixtures/thread-history.mjs';
import { matrixThreadReader } from './fixtures/matrix-thread-reader.mjs';

const resolver = loadTs('../lib/resolve-event.ts', {});
const api = loadTs('../lib/thread-history.ts', { 'matrix-js-sdk': sdk, './resolve-event': resolver });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) { for (let i = 0; i < 50; i++) { if (predicate()) return; await turn(); } assert.fail('Expected SDK operation did not start'); }
const read = f => api.readThreadEvents(f.client, f.room, f.rootId, f.root, f.current);
const older = f => api.loadOlderThreadHistory(f.client, f.room, f.rootId, f.root, f.current);
const relations = f => f.requests.filter(url => url.pathname.includes('/relations/'));

test('cached historical roots create one actual SDK Thread and load encrypted replies without a message-only filter', async context => {
  const f = threadHistoryFixture(); assert.equal(f.room.findEventById(f.rootId), undefined);
  const gate = deferred(); f.state.rootGate = gate.promise; context.after(() => gate.resolve());
  const first = read(f); await until(() => f.room.getThread(f.rootId));
  const thread = f.room.getThread(f.rootId); assert.ok(thread instanceof sdk.Thread); assert.equal(thread.initialEventsFetched, false);
  const listenerCount = thread.listenerCount(sdk.ThreadEvent.Update), second = read(f); await turn();
  assert.equal(thread.listenerCount(sdk.ThreadEvent.Update), listenerCount, 'concurrent reads share one initialization observer');
  gate.resolve(); const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.map(event => event.getId()), ['$latest']); assert.deepEqual(b.map(event => event.getId()), ['$latest']);
  assert.equal(a[0].isEncrypted(), true); await f.client.decryptEventIfNeeded(a[0]); assert.equal(a[0].getContent().body, 'Latest encrypted reply');
  assert.equal(f.room.getThread(f.rootId), thread); assert.equal(relations(f).length, 1);
  assert.equal(relations(f)[0].pathname.endsWith(encodeURIComponent(f.rootId)), true); assert.equal(thread.initialEventsFetched, true);
  assert.equal(api.threadHistoryHasOlder(f.client, f.room, f.rootId), true);
});

test('an empty actual SDK thread succeeds without getLatestTimeline or an unnecessary relations request', async () => {
  const f = threadHistoryFixture({ empty: true }); f.client.getLatestTimeline = () => { assert.fail('Empty threads must not query a nonexistent latest reply'); };
  assert.deepEqual((await read(f)).map(event => event.getId()), [f.rootId]);
  assert.equal(f.room.getThread(f.rootId).initialEventsFetched, true); assert.equal(relations(f).length, 0);
  assert.equal(api.threadHistoryHasOlder(f.client, f.room, f.rootId), false); assert.equal(await older(f), false); assert.equal(relations(f).length, 0);
});

test('earlier replies use the SDK pagination token once, retain encryption and stop at the beginning', async () => {
  const f = threadHistoryFixture(); await read(f); const gate = deferred(); f.state.pageGate = gate.promise;
  const a = older(f), b = older(f); await until(() => relations(f).length === 2);
  assert.equal(relations(f)[1].searchParams.get('from'), 'older-replies'); assert.equal(relations(f)[1].searchParams.get('limit'), '50');
  gate.resolve(); assert.deepEqual(await Promise.all([a, b]), [false, false]);
  const events = await read(f); assert.deepEqual(events.map(event => event.getId()), [f.rootId, '$first', '$second', '$latest']);
  for (const event of events) { assert.equal(event.isEncrypted(), true); await f.client.decryptEventIfNeeded(event); assert.equal(event.getType(), 'm.room.message'); }
  assert.equal(api.threadHistoryHasOlder(f.client, f.room, f.rootId), false); assert.equal(await older(f), false); assert.equal(relations(f).length, 2);
});

test('a denied older page rejects, preserves its cursor and permits a later authorized retry', async () => {
  const f = threadHistoryFixture(); await read(f); f.state.failPage = true;
  await assert.rejects(older(f), error => error.errcode === 'M_FORBIDDEN');
  assert.equal(api.threadHistoryHasOlder(f.client, f.room, f.rootId), true);
  f.state.failPage = false; await older(f); assert.equal((await read(f)).length, 4);
});

test('cross-room cached roots are discarded and a native root lookup remains scoped to the requested room', async () => {
  const f = threadHistoryFixture({ empty: true }), foreign = new sdk.MatrixEvent({ ...f.rawRoot, room_id: '!private:local' });
  await api.readThreadEvents(f.client, f.room, f.rootId, foreign, f.current);
  assert.notEqual(f.room.getThread(f.rootId).rootEvent, foreign);
  assert.equal(f.requests.filter(url => url.pathname.includes('/event/')).length, 2, 'validated lookup followed by SDK root metadata refresh');
  assert.ok(f.requests.every(url => url.pathname.includes(encodeURIComponent(f.room.roomId))));
});

test('wrong root identity, non-message state and nested thread replies cannot create thread models', async () => {
  for (const patch of [{ type: 'm.room.member', state_key: '@someone:local' }, { type: 'm.room.message', content: { body: 'Nested reply', 'm.relates_to': { rel_type: 'm.thread', event_id: '$other' } } }]) {
    const f = threadHistoryFixture(), bad = new sdk.MatrixEvent({ ...f.rawRoot, ...patch });
    await assert.rejects(api.readThreadEvents(f.client, f.room, f.rootId, bad, f.current), /original message/); assert.equal(f.room.getThread(f.rootId), null); assert.equal(f.requests.length, 0);
  }
  const f = threadHistoryFixture(); f.client.fetchRoomEvent = async () => ({ ...f.rawRoot, event_id: '$wrong' });
  await assert.rejects(api.readThreadEvents(f.client, f.room, f.rootId, undefined, f.current), /requested conversation/);
  assert.equal(f.room.getThread(f.rootId), null);
  await assert.rejects(api.readThreadEvents(f.client, f.room, 'not-an-event', f.root, f.current), /valid thread/);
});

test('room departure during actual SDK initialization prevents projection and removes wait observers', async context => {
  const f = threadHistoryFixture(), gate = deferred(); f.state.rootGate = gate.promise; context.after(() => gate.resolve());
  const pending = read(f); await until(() => f.room.getThread(f.rootId)); const thread = f.room.getThread(f.rootId);
  const updates = thread.listenerCount(sdk.ThreadEvent.Update), deletions = thread.listenerCount(sdk.ThreadEvent.Delete);
  const rejected = assert.rejects(pending, /room access changed/); f.room.updateMyMembership('leave'); await rejected;
  assert.equal(thread.listenerCount(sdk.ThreadEvent.Update), updates - 1); assert.equal(thread.listenerCount(sdk.ThreadEvent.Delete), deletions - 1, 'only SDK-owned listeners remain');
  gate.resolve(); await turn();
});

test('an account change while resolving a root cannot create a thread for the new session', async () => {
  const f = threadHistoryFixture(), gate = deferred(); f.state.rootGate = gate.promise;
  const pending = api.readThreadEvents(f.client, f.room, f.rootId, undefined, f.current); await until(() => f.requests.length > 0);
  f.state.current = false; gate.resolve(); await assert.rejects(pending, /account changed/); assert.equal(f.room.getThread(f.rootId), null);
});

test('late pagination is rejected after account, membership or live-timeline replacement', async () => {
  for (const change of ['account', 'membership', 'timeline']) {
    const f = threadHistoryFixture(); await read(f); const gate = deferred(); f.state.pageGate = gate.promise;
    const pending = older(f); await until(() => relations(f).length === 2);
    if (change === 'account') f.state.current = false;
    if (change === 'membership') f.room.updateMyMembership('leave');
    if (change === 'timeline') f.room.getThread(f.rootId).timelineSet.resetLiveTimeline('new-token');
    gate.resolve(); await assert.rejects(pending, /access changed|timeline changed/);
  }
});

test('a stalled initialization is bounded and does not call private metadata methods or fabricate an empty success', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const room = Object.assign(new EventEmitter(), { roomId: '!slow:local', getMyMembership: () => 'join' }), client = { getRoom: () => room };
  const thread = Object.assign(new EventEmitter(), { id: '$root', room, client, initialEventsFetched: false, events: [], updateThreadMetadata: () => assert.fail('Private SDK method must never be called') });
  room.getThread = () => thread;
  const pending = api.readThreadEvents(client, room, '$root', undefined, () => true); const rejection = assert.rejects(pending, /Reconnect your Matrix session/);
  await turn(); thread.emit(sdk.ThreadEvent.Update, thread); await turn();
  context.mock.timers.tick(20_000); await rejection;
  assert.equal(thread.listenerCount(sdk.ThreadEvent.Update), 0); assert.equal(room.listenerCount(sdk.RoomEvent.MyMembership), 0);
  thread.initialEventsFetched = true; assert.deepEqual(await api.readThreadEvents(client, room, '$root', undefined, () => true), []);
});

test('the actual Matrix message API consumes its scoped cached root and reports the thread cursor', async () => {
  const f = threadHistoryFixture(), matrix = matrixThreadReader(f.client); matrix.fixtureCache(f.root);
  await assert.rejects(matrix.matrixApi('messages', undefined, { parent: f.rootId }), /Choose a conversation/);
  const first = await matrix.matrixApi('messages', undefined, { conversation: f.room.roomId, parent: f.rootId });
  assert.deepEqual(first.messages.map(message => [message.id, message.parent_id]), [['$latest', f.rootId]]); assert.equal(first.hasMore, true);
  const second = await matrix.matrixApi('messages', undefined, { conversation: f.room.roomId, parent: f.rootId, before: '$latest' });
  assert.deepEqual(second.messages.map(message => message.id), ['$first', '$second', '$latest']); assert.equal(second.hasMore, false);
  assert.equal(relations(f).length, 2); assert.ok(matrix.fixtureCacheIds().includes('$first'));
});

test('an undecryptable historical reply retains its wire thread relation and visible missing-key placeholder', async () => {
  const f = threadHistoryFixture(), decrypt = f.client.decryptEventIfNeeded;
  f.client.decryptEventIfNeeded = async event => {
    if (event.getId() === '$latest' && !event.getClearContent()) await event.attemptDecryption({ decryptEvent: async () => { throw new Error('Missing test key'); } });
    else await decrypt(event);
  };
  const matrix = matrixThreadReader(f.client); matrix.fixtureCache(f.root);
  const result = await matrix.matrixApi('messages', undefined, { conversation: f.room.roomId, parent: f.rootId });
  assert.equal(result.messages.length, 1); assert.equal(result.messages[0].parent_id, f.rootId); assert.match(result.messages[0].body, /Unable to decrypt/);
  const event = f.room.getThread(f.rootId).events[0]; assert.equal(event.isDecryptionFailure(), true); assert.equal(event.getOriginalContent()['m.relates_to'], undefined); assert.equal(event.getRelation().event_id, f.rootId);
});

test('late actual Matrix decryption cannot repopulate the next account event cache', async () => {
  const f = threadHistoryFixture(), matrix = matrixThreadReader(f.client), decrypt = f.client.decryptEventIfNeeded, gate = deferred(); let decrypting = false;
  f.client.decryptEventIfNeeded = async event => { if (event.getId() === '$latest') { decrypting = true; await gate.promise; } await decrypt(event); };
  matrix.fixtureCache(f.root); const pending = matrix.matrixApi('messages', undefined, { conversation: f.room.roomId, parent: f.rootId });
  await until(() => decrypting && f.room.getThread(f.rootId)?.initialEventsFetched);
  matrix.fixtureClient(null); gate.resolve(); await assert.rejects(pending, /account or room access changed/);
  assert.deepEqual(matrix.fixtureCacheIds(), []);
});
