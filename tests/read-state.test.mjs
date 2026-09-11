import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as sdk from 'matrix-js-sdk';
import { loadTs } from './load-ts.mjs';
import { dmRequestsFixture } from './fixtures/dm-requests.mjs';

const read = loadTs('../lib/read-state.ts', {}), key = read.navigationAccountKey;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup() {
  const f = dmRequestsFixture(); f.member(f.room, 'join');
  const api = loadTs('../lib/api.ts', { './image-cache': { disposeCachedImageOwner() {} }, './response-image': {}, './web-push': { startWebPushSession() {}, stopWebPushSession() {} } }); api.setAccountDevice('A');
  const source = readFileSync(new URL('../lib/matrix.ts', import.meta.url), 'utf8') + '\nexport function fixtureClient(c:any,s:any){client=c;sdk=s;}';
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const matrix = {}, noop = new Proxy({}, { get: () => () => {} });
  new Function('require', 'exports', 'sessionStorage', code)(name => ({ './read-state': read, './api': api, './self-profile': { nativeSelfProfile: () => ({ name: 'Reader' }) } }[name] || noop), matrix, { removeItem() {} }); matrix.fixtureClient(f.client, sdk);
  const interactions = loadTs('../lib/interactions.ts', { './matrix': matrix, './api': api, './read-state': read, './social': {}, './roles': {} });
  const native = f.client.http.authedRequest;
  f.client.http.authedRequest = async (method, path, query, body) => {
    if (!path.includes('/receipt/')) return native(method, path, query, body);
    f.calls.push({ method, path, body }); await f.beforeReceipt?.(path);
    if (f.failReceipt?.(path)) throw new Error('Native receipt rejected'); return {};
  };
  f.client.supportsThreads = () => true;
  const event = async (room, id, timestamp = 1) => { const value = new sdk.MatrixEvent({ event_id: id, room_id: room.roomId, sender: '@alice:local', origin_server_ts: timestamp, type: 'm.room.message', content: { body: id, msgtype: 'm.text' } }); await room.addLiveEvents([value], {}); room.setUnreadNotificationCount(sdk.NotificationCountType.Total, 1); return value; };
  return { f, read, matrix, api, interactions, event };
}
const receipts = f => f.calls.filter(call => call.path.includes('/receipt/'));

test('actual SDK total and highlight counters reach the bootstrap with thread counts; room observers detach', async () => {
  const { f, matrix } = setup(); let updates = 0; const stop = read.watchRoomReadCounts(f.client, () => updates++);
  f.room.setUnreadNotificationCount(sdk.NotificationCountType.Total, 5); f.room.setUnreadNotificationCount(sdk.NotificationCountType.Highlight, 2);
  f.room.setThreadUnreadNotificationCount('$thread', sdk.NotificationCountType.Total, 4); f.room.setThreadUnreadNotificationCount('$thread', sdk.NotificationCountType.Highlight, 1);
  assert.deepEqual(read.roomReadCounts(f.room), { unread: 9, mentions: 3 }); assert.equal(updates, 4);
  const snapshot = await matrix.matrixApi('bootstrap'); assert.equal(snapshot.conversations[0].unread, 9); assert.equal(snapshot.conversations[0].mentions, 3); assert.equal(f.calls.length, 0);
  const second = f.add('!new:local', { membership: 'join' }); f.client.emit(sdk.ClientEvent.Room, second); second.setUnreadNotificationCount(sdk.NotificationCountType.Highlight, 2); assert.equal(updates, 5);
  stop(); second.setUnreadNotificationCount(sdk.NotificationCountType.Highlight, 4); f.room.setUnreadNotificationCount(sdk.NotificationCountType.Total, 0); assert.equal(updates, 5);
  assert.deepEqual(read.roomReadCounts({ getUnreadNotificationCount: () => -4 }), { unread: 0, mentions: 0 });
});

test('SDK forgetting a room and replacing its model release obsolete count observers', async () => {
  const { f } = setup(); let updates = 0; const stop = read.watchRoomReadCounts(f.client, () => updates++);
  const replacement = new sdk.Room(f.room.roomId, f.client, f.actor, { pendingEventOrdering: 'detached' }); f.client.store.storeRoom(replacement); f.client.emit(sdk.ClientEvent.Room, replacement);
  f.room.setUnreadNotificationCount(sdk.NotificationCountType.Total, 1); assert.equal(updates, 0); replacement.setUnreadNotificationCount(sdk.NotificationCountType.Total, 1); assert.equal(updates, 1);
  replacement.updateMyMembership('leave'); f.client.http.authedRequest = async (method, path) => { assert.equal(method, 'POST'); assert.ok(path.endsWith('/forget')); return {}; };
  await f.client.forget(replacement.roomId, true); replacement.setUnreadNotificationCount(sdk.NotificationCountType.Total, 2); assert.equal(updates, 1); assert.equal(f.client.getRoom(replacement.roomId), null); stop();
});

test('global read skips already-read rooms, snapshots highlight-only and manual rooms, while explicit room marking still works', async () => {
  const { f, matrix, event } = setup(); await event(f.room, '$already-read'); f.room.setUnreadNotificationCount(sdk.NotificationCountType.Total, 0);
  assert.deepEqual((await matrix.markMatrixRoomsRead()).marked, []); assert.equal(f.calls.length, 0);
  assert.deepEqual((await matrix.markMatrixRoomsRead([f.room.roomId])).marked, [f.room.roomId]);
  f.room.setUnreadNotificationCount(sdk.NotificationCountType.Highlight, 2); assert.deepEqual((await matrix.markMatrixRoomsRead()).marked, [f.room.roomId]);
});

test('all-read sends actual unthreaded private receipts only for joined conversations and clears captured markers without changing favorites', async () => {
  const { f, matrix, event } = setup(); await event(f.room, '$main?opaque/id');
  const privateRoom = f.add('!private:local', { membership: 'join', type: 'io.tavern.private_thread' }); await event(privateRoom, '$private');
  f.add('!space:local', { membership: 'join', type: 'm.space' }); f.add('!invited:local'); f.add('!left:local', { membership: 'leave' }); const empty = f.add('!empty:local', { membership: 'join' });
  f.accountData(key, { favorites: ['!keep:local'], unread: [f.room.roomId, privateRoom.roomId, empty.roomId, '!invited:local'], future: { keep: true } });
  const result = await matrix.markMatrixRoomsRead();
  assert.deepEqual(result.marked, [f.room.roomId, privateRoom.roomId]); assert.equal(result.skipped.length, 1); assert.equal(result.failed.length, 0);
  assert.equal(receipts(f).length, 2); assert.ok(receipts(f).every(call => call.method === 'POST' && call.path.includes('/receipt/m.read.private/') && Object.keys(call.body).length === 0));
  assert.ok(receipts(f)[0].path.endsWith(encodeURIComponent('$main?opaque/id')));
  assert.deepEqual(f.client.getAccountData(key).getContent(), { favorites: ['!keep:local'], unread: [empty.roomId, '!invited:local'], future: { keep: true } });
  assert.ok(f.calls.every(call => call.path.includes('/receipt/') || call.path.includes('/account_data/')), 'no history, membership or media fetch');
});

test('captured events do not move forward to later arrivals, and newer manual markers survive a pending batch', async () => {
  const { f, matrix, event, interactions } = setup(), second = f.add('!second:local', { membership: 'join' }); await event(f.room, '$first'); await event(second, '$captured', 2);
  f.accountData(key, { favorites: [], unread: [second.roomId] }); const entered = deferred(), gate = deferred();
  f.beforeReceipt = async () => { f.beforeReceipt = null; entered.resolve(); await gate.promise; };
  const work = matrix.markMatrixRoomsRead(); await entered.promise;
  await event(second, '$arrived-later', 3); await interactions.setNavigationFlag(second.roomId, 'unread', true); gate.resolve(); await work;
  assert.ok(receipts(f)[1].path.endsWith(encodeURIComponent('$captured'))); assert.equal(receipts(f).some(call => call.path.includes('arrived-later')), false);
  assert.deepEqual(f.client.getAccountData(key).getContent().unread, [second.roomId]);
});

test('receipt rejection and membership departure retain markers while other rooms complete; retry repairs the rejected room', async () => {
  const { f, matrix, event } = setup(), second = f.add('!second:local', { membership: 'join' }), departed = f.add('!departed:local', { membership: 'join' });
  for (const room of [f.room, second, departed]) await event(room, '$' + room.roomId);
  f.accountData(key, { favorites: [], unread: [f.room.roomId, second.roomId, departed.roomId] });
  f.failReceipt = path => path.includes(encodeURIComponent(second.roomId)); f.beforeReceipt = async () => { f.beforeReceipt = null; f.member(departed, 'leave'); };
  const result = await matrix.markMatrixRoomsRead(); assert.deepEqual(result.marked, [f.room.roomId]); assert.equal(result.failed.length, 1); assert.equal(result.skipped.length, 1);
  assert.deepEqual(f.client.getAccountData(key).getContent().unread, [second.roomId, departed.roomId]); assert.match(read.markReadSummary(result), /receipt failed/);
  f.failReceipt = null; const retry = await matrix.markMatrixRoomsRead([second.roomId]); assert.deepEqual(retry.marked, [second.roomId]); assert.deepEqual(f.client.getAccountData(key).getContent().unread, [departed.roomId]);
});

test('native account-data failure reports confirmed receipts separately, retains markers, and retries safely', async () => {
  const { f, matrix, event } = setup(); await event(f.room, '$first'); f.accountData(key, { favorites: [], unread: [f.room.roomId] });
  const save = f.client.setAccountData.bind(f.client); f.client.setAccountData = async () => { throw new Error('Native marker save rejected'); };
  const result = await matrix.markMatrixRoomsRead(); assert.deepEqual(result.marked, [f.room.roomId]); assert.match(result.markerError, /marker save rejected/); assert.deepEqual(f.client.getAccountData(key).getContent().unread, [f.room.roomId]);
  f.client.setAccountData = save; await matrix.markMatrixRoomsRead(); assert.deepEqual(f.client.getAccountData(key).getContent().unread, []);
});

test('API A to B to A or Matrix replacement during a receipt stops remaining old-account work', async () => {
  for (const change of ['generation', 'client', 'actor']) {
    const { f, matrix, event, api } = setup(), second = f.add('!second:local', { membership: 'join' }); await event(f.room, '$first'); await event(second, '$second');
    f.accountData(key, { favorites: [], unread: [f.room.roomId, second.roomId] }); const entered = deferred(), gate = deferred(); f.beforeReceipt = async () => { entered.resolve(); await gate.promise; };
    const work = matrix.markMatrixRoomsRead(), rejected = assert.rejects(work, /account changed/); await entered.promise;
    if (change === 'generation') { api.setAccountDevice('B'); api.setAccountDevice('A'); }
    else if (change === 'actor') f.client.credentials.userId = '@replacement:local';
    else matrix.fixtureClient(dmRequestsFixture().client, sdk);
    gate.resolve(); await rejected; assert.equal(receipts(f).length, 1); assert.equal(f.calls.filter(call => call.path.includes('/account_data/')).length, 0);
  }
});

test('navigation writes merge native data on the shared queue, preserve newer favorites and reject queued former-session consent', async () => {
  const { f, interactions, api } = setup(), entered = deferred(), gate = deferred();
  f.accountData(key, { favorites: ['!old:local'], unread: [], other: true }); f.beforeGet = async () => { f.beforeGet = null; entered.resolve(); await gate.promise; };
  const first = interactions.setNavigationFlag(f.room.roomId, 'unread', true); await entered.promise; const queued = interactions.setNavigationFlag('!favorite:local', 'favorites', true);
  api.setAccountDevice('B'); api.setAccountDevice('A'); const results = Promise.allSettled([first, queued]); gate.resolve(); assert.ok((await results).every(result => result.status === 'rejected'));
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  await interactions.setNavigationFlag('!favorite:local', 'favorites', true); await interactions.setNavigationFlag(f.room.roomId, 'unread', true);
  assert.deepEqual(f.client.getAccountData(key).getContent(), { favorites: ['!old:local', '!favorite:local'], unread: [f.room.roomId], other: true });
});

test('last loaded thread event is acknowledged without fetching history and a pending local tail is excluded', async () => {
  const { f, matrix, event } = setup(); sdk.Thread.setServerSideSupport(sdk.FeatureSupport.None);
  const root = await event(f.room, '$root', 1), reply = new sdk.MatrixEvent({ event_id: '$reply', room_id: f.room.roomId, sender: '@alice:local', origin_server_ts: 5, type: 'm.room.message', content: { body: 'Reply', msgtype: 'm.text', 'm.relates_to': { rel_type: sdk.THREAD_RELATION_TYPE.name, event_id: '$root' } } });
  const thread = f.room.createThread('$root', root, [root, reply], false); await new Promise(resolve => setImmediate(resolve)); assert.ok(thread instanceof sdk.Thread); assert.ok(thread.liveTimeline.getEvents().some(value => value.getId() === '$reply'));
  const pending = new sdk.MatrixEvent({ event_id: '~pending', room_id: f.room.roomId, sender: f.actor, origin_server_ts: 10, type: 'm.room.message', content: {} }); pending.setStatus(sdk.EventStatus.SENDING); f.room.getLiveTimeline().getEvents().push(pending);
  const result = await matrix.markMatrixRoomsRead(); assert.deepEqual(result.marked, [f.room.roomId]); assert.ok(receipts(f)[0].path.endsWith(encodeURIComponent('$reply'))); assert.equal(f.calls.length, 1);
});

test('server counts follow native child links and current joined rooms without exposing hidden or muted counts', () => {
  const client = sdk.createClient({ baseUrl: 'https://local', userId: '@reader:local', deviceId: 'DEVICE' });
  const add = (id, space = false) => { const room = new sdk.Room(id, client, '@reader:local', { pendingEventOrdering: 'detached' }); room.updateMyMembership('join'); room.currentState.setStateEvents([new sdk.MatrixEvent({ room_id: id, type: 'm.room.create', state_key: '', content: space ? { type: 'm.space' } : {}, event_id: '$create' + id, sender: '@reader:local' })]); client.store.storeRoom(room); return room; };
  const server = add('!server:local', true), child = add('!child:local'), hidden = add('!hidden:local'), muted = add('!muted:local');
  const link = (id, via) => server.currentState.setStateEvents([new sdk.MatrixEvent({ room_id: server.roomId, type: 'm.space.child', state_key: id, content: { via }, event_id: '$link' + id + via.length, sender: '@reader:local' })]);
  for (const room of [child, hidden, muted]) { link(room.roomId, ['local']); room.setUnreadNotificationCount(sdk.NotificationCountType.Total, 10); room.setUnreadNotificationCount(sdk.NotificationCountType.Highlight, 3); }
  const visible = new Set([child.roomId, muted.roomId]), mutes = new Set([muted.roomId]), manual = new Set([child.roomId]);
  const project = () => read.serverReadCounts(client, server.roomId, visible, mutes, manual);
  assert.deepEqual(project(), { unread: 10, mentions: 3, manual: true });
  link(child.roomId, []); assert.deepEqual(project(), { unread: 0, mentions: 0, manual: false });
  link(child.roomId, ['local']); child.updateMyMembership('invite'); assert.deepEqual(project(), { unread: 0, mentions: 0, manual: false });
  child.updateMyMembership('join'); server.updateMyMembership('leave'); assert.deepEqual(project(), { unread: 0, mentions: 0, manual: false });
  server.updateMyMembership('join'); const replacement = add(child.roomId); replacement.updateMyMembership('leave'); assert.deepEqual(project(), { unread: 0, mentions: 0, manual: false });
});
