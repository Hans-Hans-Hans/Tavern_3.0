import test from 'node:test';
import assert from 'node:assert/strict';
import { pushWorker, generation, deferred } from './fixtures/web-push-worker.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('only a current ticket may produce a generic credential-free background notice', async () => {
  const w = pushWorker(); await w.bind(generation('a')); await w.push(generation('a'), { body: 'secret plaintext', sender: '@private:local', url: 'https://evil.test' });
  assert.equal(w.notices.length, 1); assert.equal(w.notices[0].title, 'Tavern'); assert.equal(w.notices[0].body, 'You have new activity in Tavern.');
  assert.deepEqual(Object.keys(w.notices[0].data), ['generation']);
  assert.equal(w.requests[0].url, '/api/push/check'); assert.equal(w.requests[0].credentials, 'omit'); assert.equal(w.requests[0].redirect, 'error');
  assert.deepEqual(JSON.parse(w.requests[0].body), { ticket: generation('t'), generation: generation('a') });
  assert.equal(JSON.stringify([...w.stored.values()]).includes('secret'), false);
});

test('malformed, expired, unknown or permission-denied deliveries never check or display', async () => {
  const w = pushWorker(); await w.bind(generation('a'));
  for (const extra of [{ v: 2 }, { kind: 'message' }, { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 900000 }, { ticket: 'bad' }, { generation: generation('b') }]) await w.push(generation('a'), extra);
  w.options.permission = 'denied'; await w.push(generation('a')); assert.equal(w.requests.length, 0); assert.equal(w.notices.length, 0);
});

test('the persisted owner survives worker restart, while A to B to A never restores an old generation', async () => {
  const first = pushWorker(); await first.bind(generation('a'));
  const restarted = pushWorker(first.stored); await restarted.push(generation('a')); assert.equal(restarted.notices.length, 1);
  await restarted.message({ type: 'TAVERN_PUSH_CLEAR', generation: generation('a') }); await restarted.bind(generation('b')); await restarted.bind(generation('c'));
  await restarted.push(generation('a')); await restarted.push(generation('b')); assert.equal(restarted.requests.length, 1);
  await restarted.push(generation('c')); assert.equal(restarted.requests.length, 2); assert.equal(restarted.notices.at(-1).data.generation, generation('c'));
});

test('a stale generation-CAS clear cannot disable the replacement owner', async () => {
  const w = pushWorker(); await w.bind(generation('a')); await w.bind(generation('b'));
  await w.message({ type: 'TAVERN_PUSH_CLEAR', generation: generation('a') });
  await w.message({ type: 'TAVERN_PUSH_CLEAR' });
  assert.equal(w.stored.get('owner').generation, generation('b'));
});

test('logout while the backend check awaits suppresses a previously valid delivery', async () => {
  const w = pushWorker(), gate = deferred(); await w.bind(generation('a')); w.options.beforeCheck = gate.promise;
  const pending = w.push(generation('a')); await tick(); assert.equal(w.requests.length, 1);
  await w.message({ type: 'TAVERN_PUSH_CLEAR', generation: generation('a') }); gate.resolve(); await pending; assert.equal(w.notices.length, 0);
});

test('logout closes an OS notice that finishes creating after the local clear', async () => {
  const w = pushWorker(), gate = deferred(); await w.bind(generation('a')); w.options.beforeShow = gate.promise;
  w.clients.length = 0;
  const pending = w.push(generation('a')); await tick();
  w.clients.push(w.actor); await w.message({ type: 'TAVERN_PUSH_CLEAR', generation: generation('a') }); gate.resolve(); await pending;
  assert.ok(w.notices.every(notice => notice.closed));
});

test('backend suppression and a responsive current tab prevent duplicate OS alerts', async () => {
  const w = pushWorker(); await w.bind(generation('a')); w.options.show = false; await w.push(generation('a')); assert.equal(w.notices.length, 0);
  w.options.show = true; w.options.acknowledge = true; await w.push(generation('a')); assert.equal(w.notices.length, 0);
  w.options.acknowledge = false; await w.push(generation('a')); assert.equal(w.notices.length, 1);
});

test('local disable is durable across restart and a passive config refresh cannot restore it', async () => {
  const w = pushWorker(); await w.bind(generation('a')); await w.message({ type: 'TAVERN_PUSH_CLEAR', generation: generation('a') });
  const restarted = pushWorker(w.stored); assert.equal((await restarted.bind(generation('a'), { restore: true })).ok, false);
  await restarted.push(generation('a')); assert.equal(restarted.requests.length, 0);
  assert.equal((await restarted.bind(generation('b'))).ok, true);
});

test('clicks preserve existing deep links, open only root when closed, and reject old account notices', async () => {
  const w = pushWorker(); await w.bind(generation('a')); await w.push(generation('a')); const notice = w.notices[0];
  await w.emit('notificationclick', { notification: notice }); assert.deepEqual(w.focused, ['https://tavern.test/?invite=keep-me']); assert.equal(w.opened.length, 0);
  w.clients.length = 0; await w.emit('notificationclick', { notification: notice }); assert.deepEqual(w.opened, ['/']);
  w.clients.push(w.actor); await w.bind(generation('b')); await w.emit('notificationclick', { notification: notice }); assert.equal(w.focused.length, 1);
});

test('unknown clients cannot mutate push ownership', async () => {
  const w = pushWorker(); const result = await w.message({ type: 'TAVERN_PUSH_BIND', generation: generation('x'), expiresAt: Date.now() + 60000 }, { id: 'foreign', url: 'https://evil.test' });
  assert.equal(result.ok, false); assert.equal(w.stored.size, 0);
});

test('a delayed other-tab A restore cannot replace the backend current B generation', async () => {
  const w = pushWorker(); await w.bind(generation('a')); await w.message({ type: 'TAVERN_PUSH_CLEAR', generation: generation('a') });
  w.options.authorizedGeneration = generation('b'); await w.bind(generation('b'));
  assert.equal((await w.bind(generation('a'), { restore: true })).ok, false); assert.equal(w.stored.get('owner').generation, generation('b'));
  const request = w.options.bindRequests.at(-1); assert.equal(request.credentials, 'same-origin'); assert.equal(request.headers['X-Tavern-Device'], 'fixture-device'); assert.equal(request.cache, 'no-store');
});

test('binding authorization finishing after replacement or empty-owner clear cannot revive A', async () => {
  const w = pushWorker(), gate = deferred(); w.options.beforeBind = gate.promise;
  const pending = w.bind(generation('a')); await tick();
  await w.message({ type: 'TAVERN_PUSH_CLEAR', generation: generation('a') });
  w.options.beforeBind = null; w.options.authorizedGeneration = generation('b'); await w.bind(generation('b')); gate.resolve();
  assert.equal((await pending).ok, false); assert.equal(w.stored.get('owner').generation, generation('b'));
  const empty = pushWorker(), emptyGate = deferred(); empty.options.beforeBind = emptyGate.promise;
  const emptyBind = empty.bind(generation('a')); await tick(); await empty.message({ type: 'TAVERN_PUSH_CLEAR', generation: generation('a') }); emptyGate.resolve();
  assert.equal((await emptyBind).ok, false); assert.equal(empty.stored.get('owner'), undefined);
});

test('a stale clear does not cancel B delivery while its backend check is outstanding', async () => {
  const w = pushWorker(), gate = deferred(); await w.bind(generation('b')); w.options.beforeCheck = gate.promise;
  const pending = w.push(generation('b')); await tick();
  assert.equal((await w.message({ type: 'TAVERN_PUSH_CLEAR', generation: generation('a') })).cleared, false);
  gate.resolve(); await pending; assert.equal(w.notices.length, 1); assert.equal(w.notices[0].data.generation, generation('b'));
});
