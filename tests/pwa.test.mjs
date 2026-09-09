import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function worker() {
  const events = {}, entries = new Map(), fetched = [], timers = new Map(), clients = ['one', 'two'].map(id => ({ id, messages: [], postMessage(message) { this.messages.push(message); } }));
  const cache = { async put(key, value) { entries.set(key, value); }, async match(key) { return entries.get(key); } };
  let activated = 0, nonce = 0;
  const self = { location: { origin: 'https://tavern.test' }, clients: { matchAll: async () => clients, claim: async () => {} }, skipWaiting: async () => { activated++; }, addEventListener(type, listener) { (events[type] ||= []).push(listener); } };
  const source = readFileSync(new URL('../scripts/service-worker.js', import.meta.url), 'utf8').replace('__TAVERN_BUILD__', 'test-version').replace('__TAVERN_STATIC_FILES__', JSON.stringify(['/index.html', '/assets/app-hash.js', '/manifest.webmanifest']));
  vm.runInNewContext(source, { self, URL, Set, Map, Promise, crypto: { randomUUID: () => 'nonce-' + (++nonce) }, caches: { open: async () => cache, keys: async () => [] }, Request: class { constructor(path, options) { this.url = 'https://tavern.test' + path; Object.assign(this, options); } }, fetch: async request => { fetched.push(request); return { ok: true, type: 'basic', body: 'public shell' }; }, setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  const pending = [];
  function emit(type, detail = {}) { const event = { ...detail, waitUntil: promise => pending.push(promise) }; for (const listener of events[type] || []) listener(event); }
  function request(path, options = {}) { let response = null; emit('fetch', { request: { url: 'https://tavern.test' + path, method: 'GET', mode: 'cors', headers: new Headers(), ...options }, respondWith: promise => { response = promise; } }); return response; }
  return { emit, request, clients, entries, fetched, timers, pending, activated: () => activated };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('offline install stores only the explicit static build list without credentials', async () => {
  const w = worker(); w.emit('install'); await Promise.all(w.pending);
  assert.deepEqual([...w.entries.keys()], ['/index.html', '/assets/app-hash.js', '/manifest.webmanifest']);
  assert.ok(w.fetched.every(request => request.credentials === 'omit' && request.cache === 'reload'));
  assert.equal(w.activated(), 0, 'installation must never force a waiting update');
});

test('private requests, runtime config, unknown assets, uploads and call media bypass the worker', () => {
  const w = worker();
  for (const path of ['/api/auth/session', '/_matrix/client/v3/sync', '/_matrix/media/v3/download/server/id', '/tavern-config.json', '/livekit/jwt/', '/element-call/config.json', '/uploads/file', '/assets/unlisted.js', '/assets/app-hash.js?token=private']) assert.equal(w.request(path), null, path);
  assert.equal(w.request('/assets/app-hash.js', { method: 'POST' }), null);
  assert.equal(w.request('/assets/app-hash.js', { headers: new Headers({ authorization: 'Bearer secret' }) }), null);
  assert.equal(w.request('/assets/app-hash.js', { url: 'https://external.test/assets/app-hash.js' }), null);
});

test('offline navigation receives the cached shell without writing query or route data', async () => {
  const w = worker(); w.emit('install'); await Promise.all(w.pending);
  const before = w.fetched.length;
  assert.equal((await w.request('/?invite=secret', { mode: 'navigate' })).body, 'public shell');
  assert.equal((await w.request('/admin', { mode: 'navigate' })).body, 'public shell');
  assert.equal(w.fetched.length, before); assert.equal(w.entries.size, 3);
});

test('an update activates only after every actual client confirms no active session', async () => {
  const w = worker(); w.emit('message', { source: w.clients[0], data: { type: 'TAVERN_UPDATE_REQUEST' } }); await tick();
  const id = w.clients[0].messages[0].id;
  w.emit('message', { source: { id: 'intruder' }, data: { type: 'TAVERN_UPDATE_READY', id, safe: true } }); await tick(); assert.equal(w.activated(), 0);
  w.emit('message', { source: w.clients[0], data: { type: 'TAVERN_UPDATE_READY', id, safe: true } }); await tick(); assert.equal(w.activated(), 0);
  w.emit('message', { source: w.clients[1], data: { type: 'TAVERN_UPDATE_READY', id, safe: true } }); await Promise.all(w.pending);
  assert.equal(w.activated(), 1); assert.equal(w.timers.size, 0);
});

test('a single unsafe tab blocks activation and late replies cannot revive the attempt', async () => {
  const w = worker(); w.emit('message', { source: w.clients[0], data: { type: 'TAVERN_UPDATE_REQUEST' } }); await tick();
  const id = w.clients[0].messages[0].id;
  w.emit('message', { source: w.clients[1], data: { type: 'TAVERN_UPDATE_READY', id, safe: false } }); await tick();
  w.emit('message', { source: w.clients[0], data: { type: 'TAVERN_UPDATE_READY', id, safe: true } }); await Promise.all(w.pending);
  assert.equal(w.activated(), 0); assert.ok(w.clients.every(client => client.messages.some(message => message.type === 'TAVERN_UPDATE_BLOCKED')));
});

test('an unresponsive tab times out without activating the update', async () => {
  const w = worker(); w.emit('message', { source: w.clients[0], data: { type: 'TAVERN_UPDATE_REQUEST' } }); await tick();
  [...w.timers.values()][0](); await tick(); await Promise.all(w.pending);
  assert.equal(w.activated(), 0); assert.match(w.clients[0].messages.at(-1).reason, /did not respond/);
});
