import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { loadTs } from './load-ts.mjs';
import { pushWorker, generation, deferred } from './fixtures/web-push-worker.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function idle(model) { for (let count = 0; count < 100 && model.webPushSnapshot().busy; count++) await tick(); assert.equal(model.webPushSnapshot().busy, false); }
const bytes = new Uint8Array(65); bytes[0] = 4;
const publicKey = Buffer.from(bytes).toString('base64url');
function setup(stored) {
  const worker = pushWorker(stored), requests = [], events = new Map();
  const leaseTimers = new Map(); let timerId = 0;
  globalThis.setInterval = (callback, delay) => { const id = ++timerId; leaseTimers.set(id, { callback, delay }); return id; }; globalThis.clearInterval = id => leaseTimers.delete(id);
  const options = { allowed: true, permissionRequests: 0, subscriptions: 0, unsubscribed: 0, existing: null, config: { enabled: true, publicKey, subscription: null }, configGate: null, registrationGate: null, permissionGate: null, postGate: null, deleteFails: false, nextGeneration: generation('a') };
  const json = { endpoint: 'https://push.example.test/subscription', keys: { p256dh: 'browser-key', auth: 'browser-auth' } };
  const fingerprint = createHash('sha256').update(JSON.stringify([json.endpoint, json.keys.p256dh, json.keys.auth])).digest('hex');
  const native = { options: { applicationServerKey: bytes.buffer }, toJSON: () => json, async unsubscribe() { options.unsubscribed++; options.existing = null; return true; } };
  const binding = (value = options.nextGeneration) => ({ id: 'record-' + value[0], generation: value, expiresAt: Date.now() + 60000, subscriptionHash: fingerprint });
  const active = { scriptURL: 'https://tavern.test/sw.js', postMessage(data, ports) { void worker.message(data).then(reply => ports?.[0]?.postMessage(reply)); } };
  const registration = { active, pushManager: { async getSubscription() { return options.existing; }, async subscribe() { options.subscriptions++; options.existing = native; return native; } } };
  const serviceWorker = { controller: active, async getRegistration() { if (options.registrationGate) { const gate = options.registrationGate; options.registrationGate = null; return await gate; } return registration; }, addEventListener(type, listener) { events.set(type, listener); } };
  const Notification = { permission: 'granted', async requestPermission() { options.permissionRequests++; if (options.permissionGate) await options.permissionGate; return options.allowed ? 'granted' : 'denied'; } };
  globalThis.window = { isSecureContext: true, PushManager: class {}, Notification, addEventListener(type, listener) { events.set(type, listener); } }; globalThis.document = { addEventListener(type, listener) { events.set(type, listener); } }; globalThis.location = new URL('https://tavern.test'); globalThis.Notification = Notification;
  let lockTail = Promise.resolve();
  const locks = { request(_name, action) { const pending = lockTail.catch(() => {}).then(action); lockTail = pending.catch(() => {}); return pending; } };
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker, locks }, configurable: true }); Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  const newModel = () => loadTs('../lib/web-push.ts', { './api': { async requestApi(path, body, method) {
    requests.push({ path, body, method });
    if (path === '/push/foreground') return { ok: true, expiresAt: body.active ? Date.now() + 35000 : 0 };
    if (path === '/push/config') { if (options.configGate) { const gate = options.configGate; options.configGate = null; return await gate; } return options.config; }
    if (method === 'DELETE') { if (options.deleteFails) throw new Error('Offline'); options.config.subscription = null; return { ok: true }; }
    if (options.postGate) return await options.postGate;
    const result = binding(); options.config.subscription = result; return result;
  } } });
  const model = newModel();
  return { model, newModel, worker, requests, options, native, registration, binding, events, active, leaseTimers };
}

test('background push remains off until explicit consent and binds the exact browser subscription', async () => {
  const f = setup(); f.model.startWebPushSession('A'); await idle(f.model);
  assert.equal(f.options.permissionRequests, 0); assert.equal(f.options.subscriptions, 0); assert.equal(f.model.webPushSnapshot().enabled, false);
  await f.model.enableWebPush(); assert.equal(f.options.permissionRequests, 1); assert.equal(f.options.subscriptions, 1);
  assert.equal(f.requests.find(value => value.path === '/push/subscription').body.consent, true);
  assert.equal(f.worker.stored.get('owner').generation, generation('a')); assert.equal(f.model.webPushSnapshot().enabled, true);
  f.model.stopWebPushSession(); await tick();
});

test('passive restore requires the subscription fingerprint and never requests permission', async () => {
  const f = setup(); f.options.existing = f.native; f.options.config.subscription = { ...f.binding(), subscriptionHash: '0'.repeat(64) }; await f.worker.bind(generation('a'));
  f.model.startWebPushSession('A'); await idle(f.model);
  assert.equal(f.model.webPushSnapshot().enabled, false); assert.equal(f.worker.stored.get('owner').generation, generation('a'), 'an unknown page must not clear another tab owner'); assert.equal(f.options.permissionRequests, 0);
  f.model.stopWebPushSession(); await tick();
});

test('an account A config completing after B then A cannot restore the old generation', async () => {
  const f = setup(), gate = deferred(); f.options.existing = f.native; f.options.configGate = gate.promise;
  f.model.startWebPushSession('A'); await tick(); f.model.stopWebPushSession();
  f.options.config.subscription = f.binding(generation('b')); f.model.startWebPushSession('B'); await idle(f.model);
  f.model.stopWebPushSession(); f.options.config.subscription = f.binding(generation('c')); f.model.startWebPushSession('A'); await idle(f.model);
  gate.resolve({ enabled: true, publicKey, subscription: f.binding(generation('a')) }); await tick(); await tick();
  assert.equal(f.worker.stored.get('owner').generation, generation('c')); assert.equal(f.model.webPushSnapshot().enabled, true);
  f.model.stopWebPushSession(); await tick();
});

test('delayed old-owner cleanup uses generation CAS and cannot clear a newly enabled owner', async () => {
  const f = setup(), gate = deferred(); f.model.startWebPushSession('A'); await idle(f.model); await f.model.enableWebPush();
  f.options.registrationGate = gate.promise; f.model.stopWebPushSession();
  f.options.config.subscription = null; f.options.nextGeneration = generation('b'); f.model.startWebPushSession('B'); await idle(f.model); await f.model.enableWebPush();
  gate.resolve(f.registration); await tick(); await tick(); assert.equal(f.worker.stored.get('owner').generation, generation('b')); assert.equal(f.options.existing, f.native);
  f.model.stopWebPushSession(); await tick();
});

test('failed deletion leaves push off and preserves the exact server cleanup for retry', async () => {
  const f = setup(); f.model.startWebPushSession('A'); await idle(f.model); await f.model.enableWebPush(); f.options.deleteFails = true;
  await assert.rejects(f.model.disableWebPush(), /Offline/); assert.equal(f.model.webPushSnapshot().cleanupPending, true); assert.equal(f.worker.stored.get('owner').generation, null);
  await f.model.refreshWebPush(); assert.equal(f.model.webPushSnapshot().enabled, false);
  f.options.deleteFails = false; await f.model.disableWebPush(); const deletes = f.requests.filter(value => value.method === 'DELETE');
  assert.equal(deletes.length, 2); assert.deepEqual(deletes[0].body, deletes[1].body); assert.equal(f.model.webPushSnapshot().cleanupPending, false);
  f.model.stopWebPushSession(); await tick();
});

test('logout while permission or server registration waits never binds the stale owner', async () => {
  const f = setup(), permission = deferred(); f.model.startWebPushSession('A'); await idle(f.model); f.options.permissionGate = permission.promise;
  const pending = f.model.enableWebPush(); f.model.stopWebPushSession(); permission.resolve(); await assert.rejects(pending, /account/); assert.equal(f.options.subscriptions, 0);
  f.options.permissionGate = null; f.model.startWebPushSession('B'); await idle(f.model); const post = deferred(); f.options.postGate = post.promise;
  const registration = f.model.enableWebPush(); await tick(); f.model.stopWebPushSession(); post.resolve(f.binding()); await assert.rejects(registration, /account/);
  await tick(); assert.notEqual(f.worker.stored.get('owner')?.generation, generation('a'));
});

test('foreground acknowledgement requires the current account generation and live SDK handler', async () => {
  const f = setup(); f.model.startWebPushSession('A'); await idle(f.model); await f.model.enableWebPush();
  const replies = [], source = { scriptURL: f.active.scriptURL, postMessage: value => replies.push(value) };
  const deliver = value => f.events.get('message')({ source, data: { type: 'TAVERN_PUSH_FOREGROUND', nonce: 'request', generation: value } });
  deliver(generation('a')); assert.equal(replies.length, 0);
  f.model.setWebPushForegroundHandler(device => device === 'A'); deliver(generation('b')); assert.equal(replies.length, 0); deliver(generation('a')); assert.equal(replies.length, 1);
  f.model.stopWebPushSession(); deliver(generation('a')); assert.equal(replies.length, 1); await tick();
});

test('a new page recovers pending server cleanup from the worker tombstone', async () => {
  const first = setup(); first.model.startWebPushSession('A'); await idle(first.model); await first.model.enableWebPush(); first.options.deleteFails = true;
  await assert.rejects(first.model.disableWebPush());
  const restored = setup(first.worker.stored); restored.options.config.subscription = first.options.config.subscription;
  restored.model.startWebPushSession('A'); await idle(restored.model); assert.equal(restored.model.webPushSnapshot().enabled, false); assert.equal(restored.model.webPushSnapshot().cleanupPending, true);
  await restored.model.disableWebPush(); assert.equal(restored.requests.filter(value => value.method === 'DELETE').length, 1); assert.equal(restored.model.webPushSnapshot().cleanupPending, false);
  restored.model.stopWebPushSession(); await tick();
});

test('an unavailable worker does not prevent server deletion and reports incomplete local cleanup', async () => {
  const f = setup(); f.model.startWebPushSession('A'); await idle(f.model); await f.model.enableWebPush();
  const active = f.registration.active; f.registration.active = null;
  await assert.rejects(f.model.disableWebPush(), /worker/); assert.equal(f.requests.filter(value => value.method === 'DELETE').length, 1);
  assert.match(f.model.webPushSnapshot().message, /could not be fully disabled/); assert.equal(f.model.webPushSnapshot().cleanupPending, true);
  f.registration.active = active; await f.model.disableWebPush(); assert.equal(f.model.webPushSnapshot().cleanupPending, false);
  f.model.stopWebPushSession(); await tick();
});

test('foreground leases renew only for a live handler and release with ordered per-tab ownership', async () => {
  const f = setup(); let live = true; f.model.setWebPushForegroundHandler(device => live && device === 'A');
  f.model.startWebPushSession('A'); await idle(f.model); await f.model.enableWebPush();
  const leaseRequests = () => f.requests.filter(value => value.path === '/push/foreground').map(value => value.body);
  assert.equal(leaseRequests().length, 1); assert.equal(leaseRequests()[0].active, true); assert.equal(leaseRequests()[0].generation, generation('a'));
  assert.equal([...f.leaseTimers.values()][0].delay, 20000); [...f.leaseTimers.values()][0].callback();
  live = false; f.model.refreshWebPushForeground(); assert.equal(leaseRequests().at(-1).active, false);
  const inactiveCount = leaseRequests().length; [...f.leaseTimers.values()][0].callback(); assert.equal(leaseRequests().length, inactiveCount, 'inactive tabs do not heartbeat');
  live = true; f.model.refreshWebPushForeground(); f.events.get('pagehide')(); assert.equal(f.leaseTimers.size, 0); assert.equal(leaseRequests().at(-1).active, false);
  f.events.get('pageshow')(); assert.equal(leaseRequests().at(-1).active, true);
  f.model.stopWebPushSession(); assert.equal(leaseRequests().at(-1).active, false); assert.equal(f.leaseTimers.size, 0);
  const values = leaseRequests(); assert.equal(new Set(values.map(value => value.clientId)).size, 1); assert.deepEqual(values.map(value => value.sequence), values.map((_, index) => index + 1));
  const stoppedCount = values.length; f.model.refreshWebPushForeground(); assert.equal(leaseRequests().length, stoppedCount); await tick();
});

test('two independent tabs: old A cleanup never unsubscribes the shared provider now owned by B', async () => {
  const f = setup(); f.model.startWebPushSession('A'); await idle(f.model); await f.model.enableWebPush();
  const gate = deferred(); f.options.registrationGate = gate.promise; f.model.stopWebPushSession();
  const second = f.newModel(); f.options.config.subscription = null; f.options.nextGeneration = generation('b'); second.startWebPushSession('B'); await idle(second); await second.enableWebPush();
  gate.resolve(f.registration); await tick(); await tick();
  assert.equal(f.worker.stored.get('owner').generation, generation('b')); assert.equal(f.options.unsubscribed, 0); assert.equal(f.options.existing, f.native);
  const unknown = f.newModel(); unknown.stopWebPushSession(); await tick(); assert.equal(f.worker.stored.get('owner').generation, generation('b')); assert.equal(f.options.unsubscribed, 0);
  second.stopWebPushSession(); await tick();
});

test('two independent tabs: stale A disable cannot unsubscribe B or replace its registration', async () => {
  const f = setup(); f.model.startWebPushSession('A'); await idle(f.model); await f.model.enableWebPush();
  const second = f.newModel(); f.options.config.subscription = null; f.options.nextGeneration = generation('b'); second.startWebPushSession('B'); await idle(second); await second.enableWebPush();
  await assert.rejects(f.model.disableWebPush(), /Another Tavern tab/);
  assert.equal(f.worker.stored.get('owner').generation, generation('b')); assert.equal(f.options.unsubscribed, 0); assert.equal(f.options.existing, f.native);
  f.model.stopWebPushSession(); second.stopWebPushSession(); await tick();
});
