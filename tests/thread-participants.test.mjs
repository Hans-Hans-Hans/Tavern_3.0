import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from 'matrix-js-sdk';
import { loadTs } from './load-ts.mjs';
import { threadHistoryFixture } from './fixtures/thread-history.mjs';
import { matrixThreadReader } from './fixtures/matrix-thread-reader.mjs';
const history = loadTs('../lib/thread-history.ts', { 'matrix-js-sdk': sdk, './resolve-event': loadTs('../lib/resolve-event.ts', {}) });
const participants = loadTs('../lib/thread-participants.ts', { 'matrix-js-sdk': sdk, './thread-history': history });
const read = (f, options) => participants.discoverThreadParticipants(f.client, f.room, f.rootId, f.root, f.current, options);
const init = f => history.ensureThreadHistory(f.client, f.room, f.rootId, f.root, f.current);
const wait = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('Expected SDK operation'); };

test('actual SDK linked older timelines contribute authors and retain their earliest pagination cursor', async () => {
  const f = threadHistoryFixture(), thread = await init(f), live = thread.timelineSet.getLiveTimeline();
  const earlier = thread.timelineSet.addTimeline();
  earlier.addEvent(new sdk.MatrixEvent({ ...f.first, event_id: '$already-earlier', sender: '@earlier:local' }), { toStartOfTimeline: false });
  earlier.setPaginationToken('oldest-segment', sdk.Direction.Backward);
  live.setNeighbouringTimeline(earlier, sdk.Direction.Backward);
  earlier.setNeighbouringTimeline(live, sdk.Direction.Forward);
  assert.equal(live.getPaginationToken(sdk.Direction.Backward), null, 'the SDK clears a linked segment cursor');
  assert.equal(thread.events.some(event => event.getId() === '$already-earlier'), false, 'Thread.events is live-only');
  const loaded = participants.loadedThreadParticipants(f.client, f.room, f.rootId, f.current);
  assert.equal(loaded.complete, false); assert.ok(loaded.userIds.includes('@earlier:local'));
  assert.equal(history.threadHistoryHasOlder(f.client, f.room, f.rootId), true);
  f.first.sender = '@oldest:local'; f.state.historyPages = token => { assert.equal(token, 'oldest-segment'); return { chunk: [f.first] }; };
  const result = await read(f);
  assert.equal(result.complete, true); assert.equal(result.pages, 1);
  assert.deepEqual(result.userIds, ['@alice:local', '@earlier:local', '@oldest:local']);
  assert.deepEqual((await history.readThreadEvents(f.client, f.room, f.rootId, f.root, f.current)).map(event => event.getId()), [f.rootId, '$first', '$already-earlier', '$latest']);
});

test('linked exhausted segments are complete, disconnected segments and duplicate roots are not counted twice', async () => {
  const f = threadHistoryFixture(), thread = await init(f), live = thread.timelineSet.getLiveTimeline();
  const old = thread.timelineSet.addTimeline(), disconnected = thread.timelineSet.addTimeline();
  old.getEvents().push(f.root, new sdk.MatrixEvent({ ...f.first, sender: '@older:local' }));
  disconnected.getEvents().push(new sdk.MatrixEvent({ ...f.second, sender: '@disconnected:local' }));
  live.getEvents().push(f.root);
  live.setNeighbouringTimeline(old, sdk.Direction.Backward); old.setNeighbouringTimeline(live, sdk.Direction.Forward);
  const result = await read(f);
  assert.equal(result.complete, true); assert.equal(result.pages, 0); assert.equal(result.messages, 3);
  assert.deepEqual(result.userIds, ['@alice:local', '@older:local']);
  const events = await history.readThreadEvents(f.client, f.room, f.rootId, f.root, f.current);
  assert.equal(events.filter(event => event.getId() === f.rootId).length, 1);
  assert.equal(f.requests.filter(url => url.searchParams.get('from')).length, 0);
});

test('SDK pagination that joins another segment requires a fresh graph before publishing participant progress', async () => {
  const f = threadHistoryFixture(), thread = await init(f), old = thread.timelineSet.addTimeline();
  f.first.sender = '@overlap:local';
  thread.timelineSet.addEventsToTimeline([new sdk.MatrixEvent(f.first)], true, false, old, 'beyond-overlap');
  f.state.historyPages = () => ({ chunk: [f.first], next_batch: 'ignored-overlap-cursor' });
  const progress = [];
  await assert.rejects(read(f, { onProgress: value => progress.push(value) }), /timeline changed/);
  assert.equal(progress.length, 1); assert.equal(progress[0].complete, false);
  assert.equal(thread.timelineSet.getLiveTimeline().getNeighbouringTimeline(sdk.Direction.Backward), old);
  assert.equal(old.getPaginationToken(sdk.Direction.Backward), 'beyond-overlap');
  f.state.historyPages = token => { assert.equal(token, 'beyond-overlap'); return { chunk: [] }; };
  const retry = await read(f); assert.equal(retry.complete, true); assert.ok(retry.userIds.includes('@overlap:local'));
});

test('a new older link during coalesced pagination rejects both late readers without claiming completion', async () => {
  const f = threadHistoryFixture(), thread = await init(f), live = thread.timelineSet.getLiveTimeline();
  let release; f.state.pageGate = new Promise(resolve => { release = resolve; });
  const progress = [], ordinary = history.loadOlderThreadHistory(f.client, f.room, f.rootId, f.root, f.current), discovery = read(f, { onProgress: value => progress.push(value) });
  const ordinaryRejected = assert.rejects(ordinary, /timeline changed/), discoveryRejected = assert.rejects(discovery, /timeline changed/);
  await wait(() => f.requests.some(url => url.searchParams.get('from')));
  const old = thread.timelineSet.addTimeline(); old.setPaginationToken('separate-older', sdk.Direction.Backward);
  live.setNeighbouringTimeline(old, sdk.Direction.Backward); old.setNeighbouringTimeline(live, sdk.Direction.Forward);
  release(); await Promise.all([ordinaryRejected, discoveryRejected]);
  assert.equal(progress.length, 1); assert.equal(progress[0].complete, false);
  assert.equal(f.requests.filter(url => url.searchParams.get('from')).length, 1);
});

test('cycles, nonreciprocal or foreign-thread links and excessive graph size fail before discovery', async () => {
  for (const kind of ['cycle', 'one-way', 'foreign-thread', 'oversize']) {
    const f = threadHistoryFixture(), thread = await init(f), live = thread.timelineSet.getLiveTimeline();
    let previous = live;
    const count = kind === 'oversize' ? 256 : 1;
    for (let number = 0; number < count; number++) {
      const old = kind === 'foreign-thread' ? f.room.getUnfilteredTimelineSet().getLiveTimeline() : thread.timelineSet.addTimeline();
      previous.setNeighbouringTimeline(old, sdk.Direction.Backward);
      if (kind !== 'one-way') old.setNeighbouringTimeline(previous, sdk.Direction.Forward);
      previous = old;
    }
    if (kind === 'cycle') { previous.setNeighbouringTimeline(live, sdk.Direction.Backward); live.setNeighbouringTimeline(previous, sdk.Direction.Forward); }
    const progress = [];
    assert.throws(() => participants.loadedThreadParticipants(f.client, f.room, f.rootId, f.current), /timeline changed|256/);
    await assert.rejects(read(f, { onProgress: value => progress.push(value) }), /timeline changed|256/);
    assert.deepEqual(progress, []); assert.equal(f.requests.filter(url => url.searchParams.get('from')).length, 0);
  }
});

test('actual native thread pagination finds distinct historical authors without decrypting missing-key replies', async () => {
  const f = threadHistoryFixture(); f.first.sender = '@first:local'; f.second.sender = '@second:local';
  f.client.decryptEventIfNeeded = async () => {};
  const progress = [], result = await read(f, { onProgress: value => progress.push(value) });
  assert.deepEqual(result.userIds, ['@alice:local', '@first:local', '@second:local']);
  assert.equal(result.messages, 4); assert.equal(result.pages, 1); assert.equal(result.complete, true);
  assert.equal(progress[0].complete, false); assert.equal(f.requests.filter(url => url.searchParams.get('from')).length, 1);
  assert.ok(f.room.getThread(f.rootId).events.every(event => event.getWireType() === 'm.room.encrypted'));
});

test('empty advancing pages discover earlier authors and exhausted empty threads are explicit', async () => {
  const f = threadHistoryFixture(); f.first.sender = '@older:local';
  f.state.historyPages = token => token === 'older-replies' ? { chunk: [], next_batch: 'last-page' } : { chunk: [f.first] };
  const result = await read(f); assert.equal(result.pages, 2); assert.equal(result.complete, true); assert.ok(result.userIds.includes('@older:local'));
  const empty = await read(threadHistoryFixture({ empty: true })); assert.equal(empty.complete, true); assert.equal(empty.messages, 1); assert.equal(empty.pages, 0);
});

test('cycles fail as incomplete and the explicit page bound allows continuation', async () => {
  const cycle = threadHistoryFixture(); cycle.state.historyPages = token => ({ chunk: [], next_batch: token === 'older-replies' ? 'again' : 'older-replies' });
  await assert.rejects(read(cycle), /stopped advancing/);
  const f = threadHistoryFixture(); let page = 0; f.state.historyPages = () => ++page <= 20 ? { chunk: [], next_batch: 'page-' + page } : { chunk: [] };
  const partial = await read(f); assert.equal(partial.complete, false); assert.equal(partial.pages, 20);
  const complete = await read(f); assert.equal(complete.complete, true); assert.equal(complete.pages, 1);
});

test('reactions, edits, foreign roots, pending and redacted events do not invent historical authors', async () => {
  const f = threadHistoryFixture(), thread = await init(f);
  const raw = (id, relation, extra = {}) => new sdk.MatrixEvent({ ...f.first, event_id: id, sender: '@excluded:local', content: { ...f.first.content, 'm.relates_to': relation }, ...extra });
  const values = [raw('$edit', { rel_type: 'm.replace', event_id: f.rootId }), raw('$other', { rel_type: 'm.thread', event_id: '$elsewhere' }), raw('$reaction', { rel_type: 'm.annotation', event_id: f.rootId }, { type: 'm.reaction' }), raw('$foreign', { rel_type: 'm.thread', event_id: f.rootId }, { room_id: '!other:local' })];
  const pending = raw('$pending', { rel_type: 'm.thread', event_id: f.rootId }); pending.setStatus(sdk.EventStatus.SENDING); values.push(pending);
  const redacted = raw('$redacted', { rel_type: 'm.thread', event_id: f.rootId });
  redacted.makeRedacted(new sdk.MatrixEvent({ type: 'm.room.redaction', event_id: '$redaction', sender: '@me:local', content: {}, redacts: '$redacted' }), f.room); values.push(redacted);
  thread.events.push(...values);
  assert.deepEqual(participants.loadedThreadParticipants(f.client, f.room, f.rootId, f.current).userIds, ['@alice:local']);
});

test('actual Matrix discovery wrapper fences API account A to B to A without caching late old-account events', async () => {
  const f = threadHistoryFixture(), matrix = matrixThreadReader(f.client); matrix.fixtureCache(f.root);
  await init(f); let release; f.state.pageGate = new Promise(resolve => { release = resolve; });
  const progress = [], pending = matrix.discoverMatrixThreadParticipants(f.room.roomId, f.rootId, { onProgress: value => progress.push(value) });
  const rejection = assert.rejects(pending, /changed/);
  await wait(() => f.requests.some(url => url.searchParams.get('from')));
  matrix.fixtureAccountChanged(); matrix.fixtureAccountChanged(); release(); await rejection;
  assert.equal(progress.length, 1); assert.deepEqual(matrix.fixtureCacheIds(), [f.rootId]);
});

test('cancel, identity, membership and timeline changes reject delayed participant progress', async () => {
  for (const mode of ['abort', 'actor', 'device', 'membership', 'room', 'timeline']) {
    const f = threadHistoryFixture(), thread = await init(f), controller = new AbortController(); let release;
    f.state.pageGate = new Promise(resolve => { release = resolve; });
    const progress = [], pending = read(f, { signal: controller.signal, onProgress: value => progress.push(value) });
    const rejection = assert.rejects(pending, /stopped|changed/);
    await wait(() => f.requests.some(url => url.searchParams.get('from')));
    if (mode === 'abort') controller.abort();
    if (mode === 'actor') f.client.credentials.userId = '@other:local';
    if (mode === 'device') f.client.getDeviceId = () => 'replacement';
    if (mode === 'membership') f.room.updateMyMembership('leave');
    if (mode === 'room') f.client.store.storeRoom(new sdk.Room(f.room.roomId, f.client, '@me:local'));
    if (mode === 'timeline') thread.timelineSet.resetLiveTimeline('reset', null);
    release(); await rejection; assert.equal(progress.length, 1);
  }
});

test('ordinary history and discovery coalesce one native page, and failed pages can retry', async () => {
  const f = threadHistoryFixture(); await init(f); let release; f.state.pageGate = new Promise(resolve => { release = resolve; });
  const older = history.loadOlderThreadHistory(f.client, f.room, f.rootId, f.root, f.current), discovery = read(f);
  await wait(() => f.requests.some(url => url.searchParams.get('from'))); release(); await Promise.all([older, discovery]);
  assert.equal(f.requests.filter(url => url.searchParams.get('from')).length, 1);
  const retry = threadHistoryFixture(); await init(retry); retry.state.failPage = true; await assert.rejects(read(retry), error => error.errcode === 'M_FORBIDDEN');
  retry.state.failPage = false; assert.equal((await read(retry)).complete, true);
});

test('unsupported history and excessive loaded data never become a complete participant list', async () => {
  const unsupported = threadHistoryFixture(); await init(unsupported); unsupported.client.supportsThreads = () => false;
  const snapshot = participants.loadedThreadParticipants(unsupported.client, unsupported.room, unsupported.rootId, unsupported.current);
  assert.equal(snapshot.supported, false); assert.equal(snapshot.complete, false);
  await assert.rejects(read(unsupported), /does not support/);
  assert.equal(unsupported.requests.filter(url => url.searchParams.get('from')).length, 0);
  const large = threadHistoryFixture(), thread = await init(large);
  thread.events.push(...Array(20_001).fill(thread.events[0]));
  assert.throws(() => participants.loadedThreadParticipants(large.client, large.room, large.rootId, large.current), /20,000/);
  const authors = threadHistoryFixture(), populated = await init(authors);
  populated.events.push(...Array.from({ length: 5_001 }, (_, index) => new sdk.MatrixEvent({ ...authors.first, event_id: '$person' + index, sender: '@person' + index + ':local' })));
  assert.throws(() => participants.loadedThreadParticipants(authors.client, authors.room, authors.rootId, authors.current), /5,000/);
});
