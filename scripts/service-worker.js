/* Generated with an exact list of public build assets. No account data is cached. */
'use strict';
const CACHE = 'tavern-shell-__TAVERN_BUILD__';
const STATIC_FILES = __TAVERN_STATIC_FILES__;
const STATIC = new Set(STATIC_FILES);
const attempts = new Map();

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const path of STATIC_FILES) {
      const response = await fetch(new Request(path, { credentials: 'omit', cache: 'reload' }));
      if (!response.ok || response.type === 'opaque') throw new Error('The Tavern app could not be saved for offline use.');
      await cache.put(path, response);
    }
    // Updates remain waiting. Open tabs must approve a safe reload below.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('tavern-shell-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || request.headers.has('authorization')) return;
  const shell = request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/');
  if (!shell && (url.search || !STATIC.has(url.pathname))) return;
  // The versioned shell and its exact assets move together after consent.
  // Runtime configuration, API, Matrix, uploads and call media never enter this cache.
  const path = shell ? '/index.html' : url.pathname;
  event.respondWith((async () => (await caches.open(CACHE)).match(path).then(cached => cached || fetch(request)))());
});

async function block(attempt, reason) {
  clearTimeout(attempt.timer); attempts.delete(attempt.id);
  attempt.finish();
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ type: 'TAVERN_UPDATE_BLOCKED', id: attempt.id, reason });
}

self.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object' || !event.source?.id) return;
  if (data.type === 'TAVERN_UPDATE_REQUEST') {
    event.waitUntil((async () => {
      if (attempts.size) { event.source.postMessage({ type: 'TAVERN_UPDATE_BLOCKED', reason: 'An update is already being checked in another tab.' }); return; }
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (!clients.some(client => client.id === event.source.id)) return;
      let finish; const completed = new Promise(resolve => { finish = resolve; });
      const attempt = { id: crypto.randomUUID(), clients: new Set(clients.map(client => client.id)), timer: null, finish };
      attempts.set(attempt.id, attempt);
      attempt.timer = setTimeout(() => void block(attempt, 'Close other Tavern windows that did not respond, then try the update again.'), 10000);
      for (const client of clients) client.postMessage({ type: 'TAVERN_UPDATE_CHECK', id: attempt.id });
      await completed;
    })());
  } else if (data.type === 'TAVERN_UPDATE_READY') {
    event.waitUntil((async () => {
      const attempt = attempts.get(data.id);
      if (!attempt || !attempt.clients.has(event.source.id)) return;
      if (data.safe !== true) { await block(attempt, 'Sign out and finish calls in every Tavern window before updating.'); return; }
      attempt.clients.delete(event.source.id);
      if (!attempt.clients.size) { clearTimeout(attempt.timer); attempts.delete(attempt.id); await self.skipWaiting(); attempt.finish(); }
    })());
  }
});
