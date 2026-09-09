import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

export const generation = char => char.repeat(32);
export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export function pushWorker(stored = new Map()) {
  const listeners = new Map(), notices = [], requests = [], opened = [], focused = [], clients = [];
  const options = { permission: 'granted', show: true, beforeCheck: null, beforeShow: null, acknowledge: false, authorizedGeneration: null, beforeBind: null, bindRequests: [], expiries: new Map() };
  function request(result) { const value = { result }; queueMicrotask(() => value.onsuccess?.()); return value; }
  const indexedDB = { open() { const value = request({ transaction() { const transaction = { objectStore() { return { get: key => request(stored.get(key)), put(value, key) { stored.set(key, value); queueMicrotask(() => transaction.oncomplete?.()); } }; } }; return transaction; } }); return value; } };
  const self = {
    location: { origin: 'https://tavern.test' },
    registration: {
      async getNotifications() { return notices.filter(value => !value.closed); },
      async showNotification(title, data) { if (options.beforeShow) await options.beforeShow; const notice = { title, ...data, close() { this.closed = true; } }; notices.push(notice); },
    },
    clients: { async matchAll() { return clients; }, async openWindow(url) { opened.push(url); } },
    addEventListener(type, listener) { const list = listeners.get(type) || []; list.push(listener); listeners.set(type, list); },
  };
  async function emit(type, data = {}) { const promises = [], event = { ...data, waitUntil: promise => promises.push(promise) }; for (const listener of listeners.get(type) || []) listener(event); await Promise.all(promises); }
  function client(id = 'tab', url = 'https://tavern.test/?invite=keep-me') {
    const value = { id, url, async focus() { focused.push(url); }, postMessage(data) { if (options.acknowledge && data.type === 'TAVERN_PUSH_FOREGROUND') void emit('message', { source: value, data: { type: 'TAVERN_PUSH_FOREGROUND_ACK', generation: data.generation, nonce: data.nonce } }); } }; clients.push(value); return value;
  }
  const actor = client();
  const source = readFileSync(new URL('../../scripts/service-worker.js', import.meta.url), 'utf8').replace('__TAVERN_BUILD__', 'push-test').replace('__TAVERN_STATIC_FILES__', '[]');
  vm.runInNewContext(source, { self, indexedDB, Notification: { get permission() { return options.permission; } }, Date, Number, URL, Set, Map, Promise, crypto: webcrypto, AbortSignal, setTimeout: (fn, delay) => setTimeout(fn, delay === 1000 ? 5 : delay), clearTimeout,
    fetch: async (url, init) => {
      if (url === '/api/push/bind') { options.bindRequests.push({ url, ...init }); const data = JSON.parse(init.body), answer = { valid: !options.authorizedGeneration || options.authorizedGeneration === data.generation, generation: data.generation, expiresAt: options.expiries.get(data.generation) }; if (options.beforeBind) await options.beforeBind; return { ok: true, async json() { return answer; } }; }
      requests.push({ url, ...init }); if (options.beforeCheck) await options.beforeCheck; return { ok: true, async json() { return { show: options.show }; } };
    },
  });
  async function message(data, source = actor) { if (data.type === 'TAVERN_PUSH_BIND') options.expiries.set(data.generation, data.expiresAt); let reply; await emit('message', { source, data, ports: [{ postMessage: value => { reply = value; } }] }); return reply; }
  const bind = (value, extra = {}) => message({ type: 'TAVERN_PUSH_BIND', generation: value, expiresAt: Date.now() + 60000, device: 'fixture-device', ...extra });
  const push = (value, extra = {}) => emit('push', { data: { json: () => ({ v: 1, kind: 'activity', generation: value, ticket: generation('t'), expiresAt: Date.now() + 30000, ...extra }) } });
  return { stored, options, notices, requests, opened, focused, clients, actor, emit, message, bind, push };
}
