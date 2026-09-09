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

// Push ownership is separate from the public shell cache. Only an opaque
// generation and expiry are persisted; no credentials, profiles or room data.
let pushDatabase, pushMutations = Promise.resolve(), pushRevision = 0;
const foregroundChecks = new Map();
const pendingBindings = new Set();
function pushStore() {
  if (!pushDatabase) pushDatabase = new Promise((resolve, reject) => {
    const request = indexedDB.open('tavern-push', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => { pushDatabase = null; throw error; });
  return pushDatabase;
}
async function readPushOwner() {
  const database = await pushStore();
  return new Promise((resolve, reject) => {
    const request = database.transaction('settings', 'readonly').objectStore('settings').get('owner');
    request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
  });
}
async function writePushOwner(owner) {
  const database = await pushStore();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('settings', 'readwrite');
    transaction.objectStore('settings').put(owner, 'owner');
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
  });
}
const generationValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,160}$/.test(value);
const livePushOwner = value => !!value && generationValid(value.generation) && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now();
async function closePushNotices(generation) {
  for (const notice of await self.registration.getNotifications()) {
    if (notice.tag === 'tavern-background' && (!generation || notice.data?.generation === generation)) notice.close();
  }
}
async function sourceIsLocal(source) {
  if (!source?.id) return false;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.some(client => client.id === source.id && new URL(client.url).origin === self.location.origin);
}
self.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'TAVERN_PUSH_FOREGROUND_ACK') {
    const check = foregroundChecks.get(data.nonce);
    if (check && check.generation === data.generation && check.clients.has(event.source?.id)) check.finish(true);
    return;
  }
  if (!['TAVERN_PUSH_BIND', 'TAVERN_PUSH_CLEAR', 'TAVERN_PUSH_STATUS'].includes(data.type) || !event.source?.id) return;
  const proposal = data.type === 'TAVERN_PUSH_BIND' ? { generation: data.generation, cancelled: false } : null;
  if (proposal) pendingBindings.add(proposal);
  const enqueue = action => { const result = pushMutations.catch(() => {}).then(action); pushMutations = result.catch(() => {}); return result; };
  event.waitUntil((async () => {
    try {
      if (!await sourceIsLocal(event.source)) throw new Error('Unknown source.');
      if (data.type === 'TAVERN_PUSH_BIND') {
        if (!livePushOwner(data) || typeof data.device !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,255}$/.test(data.device)) throw new Error('Invalid binding.');
        await pushMutations;
        const revision = pushRevision;
        const response = await fetch('/api/push/bind', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json', 'X-Tavern-Device': data.device }, body: JSON.stringify({ generation: data.generation }), signal: AbortSignal.timeout(4000) });
        const authorization = response.ok ? await response.json() : null;
        if (authorization?.valid !== true || authorization.generation !== data.generation || authorization.expiresAt !== data.expiresAt) throw new Error('The current account does not own this binding.');
        await enqueue(async () => {
          const previous = await readPushOwner();
          if (proposal.cancelled || revision !== pushRevision || !livePushOwner(data) || data.restore === true && previous?.blockedGeneration === data.generation) throw new Error('The notification owner changed.');
          if (previous?.generation === data.generation && previous.expiresAt === data.expiresAt) return;
          pushRevision++;
          await writePushOwner({ generation: data.generation, expiresAt: data.expiresAt });
          await closePushNotices();
        });
        event.ports?.[0]?.postMessage({ ok: true });
      } else {
        // A clear cancels only this generation's pending proposals, including
        // an empty-owner ABA. A stale clear never cancels another owner's push.
        if (data.type === 'TAVERN_PUSH_CLEAR') for (const pending of pendingBindings) if (pending.generation === data.generation) pending.cancelled = true;
        await enqueue(async () => {
          const previous = await readPushOwner();
          if (data.type === 'TAVERN_PUSH_STATUS') { event.ports?.[0]?.postMessage({ ok: true, generation: previous?.generation, blockedGeneration: previous?.blockedGeneration }); return; }
          let cleared = false;
          if (generationValid(data.generation) && data.generation === previous?.generation) {
            pushRevision++;
            await writePushOwner({ generation: null, expiresAt: 0, blockedGeneration: previous.generation });
            await closePushNotices(data.generation); cleared = true;
          } else if (generationValid(data.generation) && data.generation === previous?.blockedGeneration) cleared = true;
          event.ports?.[0]?.postMessage({ ok: true, cleared });
        });
      }
    } catch { event.ports?.[0]?.postMessage({ ok: false }); }
    finally { if (proposal) pendingBindings.delete(proposal); }
  })());
});

async function handledByOpenTab(generation) {
  const clients = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(client => new URL(client.url).origin === self.location.origin);
  if (!clients.length) return false;
  const nonce = crypto.randomUUID();
  return new Promise(resolve => {
    let timer;
    const finish = handled => { clearTimeout(timer); foregroundChecks.delete(nonce); resolve(handled); };
    foregroundChecks.set(nonce, { generation, clients: new Set(clients.map(client => client.id)), finish });
    timer = setTimeout(() => finish(false), 1000);
    for (const client of clients) client.postMessage({ type: 'TAVERN_PUSH_FOREGROUND', nonce, generation });
  });
}
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    try {
      const data = event.data?.json();
      if (!data || data.v !== 1 || data.kind !== 'activity' || !generationValid(data.generation) || typeof data.ticket !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(data.ticket) || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= Date.now() || data.expiresAt > Date.now() + 300000) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      await pushMutations;
      const revision = pushRevision, owner = await readPushOwner();
      if (!livePushOwner(owner) || owner.generation !== data.generation) return;
      const response = await fetch('/api/push/check', { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: data.ticket, generation: data.generation }), signal: AbortSignal.timeout(10000) });
      if (!response.ok || (await response.json()).show !== true || data.expiresAt <= Date.now() || revision !== pushRevision) return;
      if (await handledByOpenTab(data.generation)) return;
      await pushMutations;
      const latest = await readPushOwner();
      if (revision !== pushRevision || !livePushOwner(latest) || latest.generation !== data.generation || data.expiresAt <= Date.now() || Notification.permission !== 'granted') return;
      await self.registration.showNotification('Tavern', { body: 'You have new activity in Tavern.', tag: 'tavern-background', silent: true, data: { generation: data.generation } });
      // Logout may arrive while the browser is creating the OS notification.
      if (revision !== pushRevision) await closePushNotices(data.generation);
    } catch { /* Offline, denied, revoked, malformed or unavailable: no notice. */ }
  })());
});
self.addEventListener('notificationclick', event => {
  if (event.notification?.tag !== 'tavern-background') return;
  event.notification.close();
  event.waitUntil((async () => {
    try {
      await pushMutations;
      const revision = pushRevision, owner = await readPushOwner();
      if (!livePushOwner(owner) || owner.generation !== event.notification.data?.generation) return;
      const clients = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(client => new URL(client.url).origin === self.location.origin);
      if (revision !== pushRevision || !livePushOwner(owner)) return;
      // Focus without navigating an existing tab: pending invites, recovery and
      // conversation deep links must survive. Payloads never choose a URL.
      if (clients.length) await (clients.find(client => client.focused) || clients[0]).focus();
      else await self.clients.openWindow('/');
    } catch { /* An expired owner or unavailable browser opens nothing. */ }
  })());
});
