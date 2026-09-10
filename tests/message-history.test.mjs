import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from 'matrix-js-sdk';
import { loadTs } from './load-ts.mjs';
import { messageHistoryFixture } from './fixtures/message-history.mjs';
const { JoinedMessageHistory } = loadTs('../lib/message-history.ts', { 'matrix-js-sdk': sdk });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await turn(); } assert.fail('Expected native SDK operation'); }
const session = (context, f) => { const value = new JoinedMessageHistory(f); context.after(() => value.dispose()); return value; };

test('actual SDK context loads encrypted surrounding events and forwards joins the live segment', async context => {
  const f = messageHistoryFixture(), history = session(context, f), first = await history.load();
  assert.deepEqual(first.messages.map(m => m.id), ['$before', f.eventId, '$after']); assert.equal(first.messages[1].body, 'Selected message');
  assert.equal(first.older, true); assert.equal(first.newer, true); assert.equal(first.atLive, false);
  assert.ok(f.requests[0].pathname.endsWith(encodeURIComponent(f.eventId))); assert.equal(f.requests[0].searchParams.has('filter'), false);
  const later = await history.page('newer'); assert.equal(later.messages.at(-1).id, '$later');
  const joined = await history.page('newer'); assert.equal(joined.messages.at(-1).id, '$live'); assert.equal(joined.atLive, true); assert.equal(joined.newer, false);
  assert.equal(new Set(joined.messages.map(m => m.id)).size, joined.messages.length);
  assert.equal(f.requests.length, 3); assert.equal(f.requests[1].searchParams.get('dir'), 'f'); assert.equal(f.requests[1].searchParams.get('limit'), '50');
});

test('empty backward page remains pageable and native beginning stops further reads', async context => {
  const f = messageHistoryFixture(), history = session(context, f); await history.load();
  const empty = await history.page('older'); assert.equal(empty.emptyPage, true); assert.equal(empty.older, true); assert.equal(f.requests.length, 2);
  const older = await history.page('older'); assert.equal(older.messages[0].id, '$older'); assert.equal(older.older, false);
  await history.page('older'); assert.equal(f.requests.length, 3); assert.equal(f.requests[2].searchParams.get('from'), 'b1');
});

test('native limit-zero context is followed by at most one SDK page per side', async context => {
  const f = messageHistoryFixture();
  f.state.context = { event: f.target, state: [], start: 'b0', end: 'f0' };
  f.state.pages = (from, dir) => ({ chunk: [dir === 'b' ? f.before : f.after], start: from, end: dir + '1' });
  const history = session(context, f), value = await history.load();
  assert.deepEqual(value.messages.map(m => m.id), ['$before', f.eventId, '$after']);
  assert.equal(f.requests[0].searchParams.get('limit'), '0'); assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests.slice(1).map(url => [url.searchParams.get('dir'), url.searchParams.get('limit')]), [['b', '25'], ['f', '25']]);
});

test('a rejected native page preserves cursor and permits deliberate retry without duplicate content', async context => {
  const f = messageHistoryFixture(), history = session(context, f); await history.load(); f.state.failPage = true;
  await assert.rejects(history.page('newer'), error => error.errcode === 'M_FORBIDDEN');
  f.state.failPage = false; const value = await history.page('newer'); assert.equal(value.messages.at(-1).id, '$later');
  assert.equal(f.requests[1].searchParams.get('from'), f.requests[2].searchParams.get('from'));
});

test('a repeated forward endpoint stops and alternating cursors fail without an endless request loop', async context => {
  const f = messageHistoryFixture(), history = session(context, f); await history.load();
  f.state.pages = from => ({ chunk: [], start: from, end: from });
  const end = await history.page('newer'); assert.equal(end.newer, false); assert.equal(end.atLive, false); assert.equal(f.requests.length, 2);
  const g = messageHistoryFixture(), other = session(context, g); await other.load();
  g.state.pages = from => ({ chunk: [], start: from, end: from === 'b0' ? 'b1' : 'b0' });
  await other.page('older'); await other.page('older'); await assert.rejects(other.page('older'), /repeated a history cursor/); assert.equal(g.requests.length, 3);
});

test('view window trims cached events to500 without new requests and releases only its own SDK listener', async context => {
  const f = messageHistoryFixture(), set = f.set, timeline = set.getLiveTimeline();
  for (let i = 0; i < 1100; i++) set.addLiveEvent(new sdk.MatrixEvent(f.encrypted('$cached-' + i, 'Cached ' + i, i + 20)), { addToState: true });
  f.eventId = '$cached-0'; const before = f.listenerCount(), history = session(context, f); let value = await history.load();
  assert.equal(f.listenerCount(), before + 1); assert.equal(value.targetPresent, true);
  for (let i = 0; i < 12; i++) value = await history.page('newer');
  assert.equal(value.messages.length, 500); assert.equal(value.limited, true); assert.equal(value.targetPresent, false); assert.equal(f.requests.length, 0);
  history.dispose(); history.dispose(); assert.equal(f.listenerCount(), before);
});

test('closed or replaced owners, room membership, device and homeserver changes reject delayed reads', async context => {
  for (const change of ['dispose', 'account', 'membership', 'device', 'homeserver']) {
    const f = messageHistoryFixture(), before = f.listenerCount(), history = session(context, f), gate = deferred(); context.after(() => gate.resolve());
    f.state.contextGate = gate.promise; const pending = history.load(); const rejected = assert.rejects(pending, /closed|access changed/);
    await until(() => f.requests.length === 1);
    if (change === 'dispose') history.dispose();
    if (change === 'account') f.state.current = false;
    if (change === 'membership') f.room.updateMyMembership('leave');
    if (change === 'device') f.client.getDeviceId = () => 'REPLACED';
    if (change === 'homeserver') f.client.getHomeserverUrl = () => 'https://other.local';
    gate.resolve(); await rejected; history.dispose(); assert.equal(f.listenerCount(), before);
  }
});

test('decryption owner checks prevent projection, overlapping operations and late stale output', async context => {
  const f = messageHistoryFixture(), history = session(context, f), gate = deferred(); context.after(() => gate.resolve());
  let projected = 0; f.project = () => { projected++; return []; }; f.state.decryptGate = gate.promise;
  const pending = history.load(), rejected = assert.rejects(pending, /access changed/); await until(() => f.set.getTimelineForEvent(f.eventId));
  await assert.rejects(history.refresh(), /Wait for this history/); f.state.current = false; gate.resolve(); await rejected; assert.equal(projected, 0);
});

test('a full SDK timeline reset and foreign segment are rejected during context reads', async context => {
  const f = messageHistoryFixture(), history = session(context, f); await history.load();
  const gate = deferred(); context.after(() => gate.resolve()); f.state.pageGate = gate.promise;
  const pending = history.page('newer'), rejected = assert.rejects(pending, /timeline changed/); await until(() => f.requests.length === 2);
  f.set.resetLiveTimeline('replacement'); gate.resolve(); await rejected;
  const g = messageHistoryFixture(), second = session(context, g); await second.load();
  const foreign = new sdk.Room('!foreign:local', g.client, '@me:local', { timelineSupport: true });
  g.set.getTimelineForEvent(g.eventId).setNeighbouringTimeline(foreign.getLiveTimeline(), sdk.Direction.Forward);
  await assert.rejects(second.refresh(), /timeline changed/);
});

test('missing keys stay visible and invalid target IDs cannot issue a context request', async context => {
  const f = messageHistoryFixture(); f.state.missingKey = true;
  const value = await session(context, f).load(); assert.equal(value.messages[1].body, 'Missing key');
  assert.throws(() => new JoinedMessageHistory({ ...f, eventId: 'not-native' }), /valid message/);
});

test('stalled SDK context is bounded and releases view listeners without stopping the live client', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = messageHistoryFixture(), before = f.listenerCount(), history = session(context, f), gate = deferred(); context.after(() => gate.resolve());
  f.state.contextGate = gate.promise; f.client.stopClient = () => assert.fail('A context cannot stop the live client');
  const pending = history.load(), rejected = assert.rejects(pending, /20 seconds/); await until(() => f.requests.length === 1);
  context.mock.timers.tick(20_000); await rejected; assert.equal(f.listenerCount(), before);
});
