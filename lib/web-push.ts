import { requestApi } from './api';

type Binding = { id: string; generation: string; expiresAt: number; subscriptionHash: string };
type Configuration = { enabled: boolean; publicKey: string; subscription: Binding | null };
type PushState = { supported: boolean; available: boolean; enabled: boolean; busy: boolean; cleanupPending: boolean; message: string };
const listeners = new Set<() => void>();
let state: PushState = { supported: false, available: false, enabled: false, busy: false, cleanupPending: false, message: '' };
let owner: { device: string; handlesNotifications: () => boolean; leaseId: string; leaseSequence: number } | null = null, binding: Binding | null = null, configuration: Configuration | null = null;
let pendingCleanup: Binding | null = null;
let installed = false, operation = 0;
let foregroundHandler: ((deviceId: string) => boolean) | null = null;
let foregroundTimer: ReturnType<typeof setInterval> | null = null, foregroundActive = false;
export function setWebPushForegroundHandler(handler: ((deviceId: string) => boolean) | null) { foregroundHandler = handler; refreshWebPushForeground(); }
export function refreshWebPushForeground() { sendForegroundLease(); }
function foregroundHandled() {
  try { return !!owner && (owner.handlesNotifications() || foregroundHandler?.(owner.device) === true); } catch { return false; }
}
function sendForegroundLease(force?: boolean, renew = false) {
  const expected = owner, currentBinding = binding;
  if (!expected || !validBinding(currentBinding)) return;
  const active = force ?? foregroundHandled();
  if (!active && !foregroundActive) return;
  if (!renew && active === foregroundActive) return;
  foregroundActive = active;
  // Capture the old device header synchronously, before an account boundary can
  // install a different cookie/device. The lease never carries a Matrix token.
  void requestApi('/push/foreground', { generation: currentBinding.generation, clientId: expected.leaseId, sequence: ++expected.leaseSequence, active }).catch(() => {});
}
function startForegroundLease() {
  if (foregroundTimer) clearInterval(foregroundTimer);
  sendForegroundLease(undefined, true);
  foregroundTimer = setInterval(() => sendForegroundLease(undefined, true), 20000);
}
function stopForegroundLease() {
  if (foregroundTimer) clearInterval(foregroundTimer);
  foregroundTimer = null; sendForegroundLease(false, true); foregroundActive = false;
}
const publish = (change: Partial<PushState>) => { state = { ...state, ...change }; listeners.forEach(listener => listener()); };
export const webPushSnapshot = () => state;
export function subscribeWebPush(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
const supported = () => typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const validBinding = (value: Binding | null): value is Binding => !!value && typeof value.id === 'string' && value.id.length <= 200 && /^[A-Za-z0-9_-]{20,160}$/.test(value.generation) && /^[a-f0-9]{64}$/.test(value.subscriptionHash) && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now();
function current(expected: typeof owner, version: number): asserts expected is NonNullable<typeof owner> { if (!expected || owner !== expected || operation !== version) throw new Error('Your account or notification settings changed. Reopen this panel.'); }
async function providerLock<T>(action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return Promise.reject(new Error('This browser needs Web Locks support to safely manage background notifications.'));
  return await navigator.locks.request('tavern-web-push-provider', action);
}

async function registration() {
  const value = await navigator.serviceWorker.getRegistration('/');
  if (!value?.active || value.active.scriptURL !== new URL('/sw.js', location.origin).href) throw new Error('The installed Tavern worker is not ready. Reload Tavern and try again.');
  return value;
}
async function workerMessage(value: ServiceWorkerRegistration, data: object): Promise<{ generation?: string; blockedGeneration?: string; cleared?: boolean }> {
  const target = value.active;
  if (!target) throw new Error('The Tavern worker is not ready.');
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel(), timer = setTimeout(() => { channel.port1.close(); reject(new Error('Background notification storage did not respond. Try again.')); }, 5000);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); if (event.data?.ok === true) resolve(event.data); else reject(new Error('Background notification storage is unavailable or this subscription was turned off.')); };
    try { target.postMessage(data, [channel.port2]); } catch (error) { clearTimeout(timer); channel.port1.close(); channel.port2.close(); reject(error); }
  });
}
async function clearWorker(value: ServiceWorkerRegistration, generation: string | undefined, active: () => boolean) {
  // Unknown/stale pages must never adopt another tab's generation for cleanup.
  return active() && generation ? (await workerMessage(value, { type: 'TAVERN_PUSH_CLEAR', generation })).cleared === true : false;
}
export async function webPushSubscriptionHash(subscription: PushSubscription): Promise<string> {
  const value = subscription.toJSON();
  const bytes = new TextEncoder().encode(JSON.stringify([value.endpoint, value.keys?.p256dh, value.keys?.auth]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function installListener() {
  if (installed || !supported()) return;
  installed = true;
  document.addEventListener('visibilitychange', () => sendForegroundLease(undefined, true));
  window.addEventListener('pagehide', stopForegroundLease);
  window.addEventListener('pageshow', () => { if (owner && binding) startForegroundLease(); });
  navigator.serviceWorker.addEventListener('message', event => {
    const source = event.source as ServiceWorker | null, data = event.data;
    if (source?.scriptURL !== new URL('/sw.js', location.origin).href || data?.type !== 'TAVERN_PUSH_FOREGROUND' || !owner || !binding || data.generation !== binding.generation || !validBinding(binding)) return;
    // A responsive, synced tab keeps its existing decrypted SDK alerts. A frozen
    // or closed tab cannot acknowledge and the worker falls back to generic push.
    if (foregroundHandled()) source.postMessage({ type: 'TAVERN_PUSH_FOREGROUND_ACK', generation: binding.generation, nonce: data.nonce });
  });
}

/** Call after the managed account device is installed. Never requests permission. */
export function startWebPushSession(deviceId: string, handlesNotifications: () => boolean = () => false) {
  if (owner?.device === deviceId) { owner.handlesNotifications = handlesNotifications; return; }
  if (owner) stopWebPushSession();
  owner = { device: deviceId, handlesNotifications, leaseId: supported() ? crypto.randomUUID() : '', leaseSequence: 0 }; configuration = null; binding = null; pendingCleanup = null;
  installListener(); publish({ supported: supported(), available: false, enabled: false, busy: false, cleanupPending: false, message: '' });
  if (supported()) void refreshWebPush().catch(() => {});
}

/** Synchronous owner invalidation precedes all asynchronous cleanup. */
export function stopWebPushSession() {
  stopForegroundLease();
  const previous = binding || pendingCleanup; owner = null; binding = null; pendingCleanup = null; configuration = null; operation++;
  publish({ available: false, enabled: false, busy: false, cleanupPending: false, message: '' });
  if (!supported()) return;
  if (previous && navigator.serviceWorker.controller?.scriptURL === new URL('/sw.js', location.origin).href) navigator.serviceWorker.controller.postMessage({ type: 'TAVERN_PUSH_CLEAR', generation: previous.generation });
  // The provider belongs to the browser, not this tab. Logout never unsubscribes
  // it: another tab may already have reused it under a fresh backend generation.
  // Session revocation is authoritative when this page has no known generation.
  if (previous) void registration().then(value => clearWorker(value, previous.generation, () => true)).catch(() => {});
}

export async function refreshWebPush() {
  const expected = owner, version = ++operation;
  if (!expected || !supported()) return;
  publish({ busy: true, message: '' });
  try {
    const config = await requestApi<Configuration>('/push/config'); current(expected, version);
    configuration = config;
    await providerLock(async () => {
    current(expected, version);
    const value = await registration(); current(expected, version);
    if (!config.enabled) { stopForegroundLease(); await clearWorker(value, binding?.generation, () => owner === expected && operation === version); current(expected, version); binding = null; publish({ available: false, enabled: false, message: 'Background notifications are not enabled on this server.' }); return; }
    const subscription = await value.pushManager.getSubscription(); current(expected, version);
    const persisted = await workerMessage(value, { type: 'TAVERN_PUSH_STATUS' }); current(expected, version);
    if (validBinding(config.subscription) && persisted.blockedGeneration === config.subscription.generation) {
      stopForegroundLease(); pendingCleanup = config.subscription; binding = null;
      publish({ available: true, enabled: false, cleanupPending: true, message: 'Notifications were turned off here. Retry server cleanup or enable them again.' }); return;
    }
    const matches = subscription && validBinding(config.subscription) && await webPushSubscriptionHash(subscription) === config.subscription.subscriptionHash; current(expected, version);
    if (matches && validBinding(config.subscription) && config.subscription.generation !== pendingCleanup?.generation && Notification.permission === 'granted') {
      await workerMessage(value, { type: 'TAVERN_PUSH_BIND', generation: config.subscription.generation, expiresAt: config.subscription.expiresAt, device: expected.device, restore: true }); current(expected, version);
      binding = config.subscription; startForegroundLease(); publish({ available: true, enabled: true });
    } else {
      stopForegroundLease();
      await clearWorker(value, binding?.generation, () => owner === expected && operation === version); current(expected, version);
      binding = null; publish({ available: true, enabled: false });
    }
    });
  } catch (error) { if (owner === expected && operation === version) publish({ message: (error as Error).message }); throw error; }
  finally { if (owner === expected && operation === version) publish({ busy: false }); }
}

function applicationKey(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(value)) throw new Error('The server notification key is invalid.');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  if (raw.length !== 65 || raw.charCodeAt(0) !== 4) throw new Error('The server notification key is invalid.');
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

/** This is the only permission/subscription entry point; invoke from a click. */
export async function enableWebPush() {
  const expected = owner, config = configuration, version = ++operation;
  current(expected, version);
  if (!supported() || !config?.enabled) throw new Error('Background notifications are unavailable.');
  publish({ busy: true, message: '' });
  try {
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications were not allowed. Change this in browser site settings to enable them.'); current(expected, version);
    await providerLock(async () => {
    current(expected, version);
    const fresh = await requestApi<Configuration>('/push/config'); current(expected, version);
    if (!fresh.enabled) throw new Error('Background notifications are unavailable.');
    const key = applicationKey(fresh.publicKey);
    const value = await registration(); current(expected, version);
    let subscription = await value.pushManager.getSubscription(); current(expected, version);
    if (subscription) {
      const previousKey = subscription.options.applicationServerKey;
      if (!previousKey || new Uint8Array(previousKey).some((byte, index) => byte !== key[index]) || previousKey.byteLength !== key.byteLength) {
        await subscription.unsubscribe(); current(expected, version); subscription = null;
      }
    }
    subscription ||= await value.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); current(expected, version);
    const result = await requestApi<Binding>('/push/subscription', { consent: true, subscription: subscription.toJSON() }); current(expected, version);
    if (!validBinding(result) || result.subscriptionHash !== await webPushSubscriptionHash(subscription)) throw new Error('The server returned an invalid notification subscription.'); current(expected, version);
    await workerMessage(value, { type: 'TAVERN_PUSH_BIND', generation: result.generation, expiresAt: result.expiresAt, device: expected.device }); current(expected, version);
    stopForegroundLease(); binding = result; pendingCleanup = null; startForegroundLease(); publish({ enabled: true, cleanupPending: false });
    });
  } catch (error) { if (owner === expected && operation === version) publish({ message: (error as Error).message }); throw error; }
  finally { if (owner === expected && operation === version) publish({ busy: false }); }
}

export async function disableWebPush() {
  const expected = owner, previous = binding || pendingCleanup, version = ++operation;
  current(expected, version); stopForegroundLease(); pendingCleanup = previous; binding = null; publish({ busy: true, enabled: false, cleanupPending: !!previous, message: '' });
  let localCleared = false;
  try {
    await providerLock(async () => {
    current(expected, version);
    const fresh = await requestApi<Configuration>('/push/config'); current(expected, version);
    if (fresh.subscription && fresh.subscription.generation !== previous?.generation) throw new Error('Another Tavern tab changed background notifications. Refresh their status.');
    let value: ServiceWorkerRegistration | null = null;
    let cleanupError: unknown;
    try { value = await registration(); } catch (error) { cleanupError = error; } current(expected, version);
    let ownProvider = false;
    if (value) { try {
      const worker = await workerMessage(value, { type: 'TAVERN_PUSH_STATUS' }); current(expected, version);
      if (worker.generation && worker.generation !== previous?.generation) throw new Error('Another Tavern tab changed background notifications. Refresh their status.');
      ownProvider = !!previous && (worker.generation === previous.generation || worker.blockedGeneration === previous.generation);
      localCleared = await clearWorker(value, previous?.generation, () => owner === expected && operation === version);
    } catch (error) { cleanupError ||= error; } current(expected, version); }
    if (previous) { try { await requestApi('/push/subscription', { id: previous.id, generation: previous.generation }, 'DELETE'); } catch (error) { cleanupError ||= error; } current(expected, version); }
    if (value && ownProvider && previous) {
      const subscription = await value.pushManager.getSubscription(); current(expected, version);
      if (subscription && await webPushSubscriptionHash(subscription) === previous.subscriptionHash) { current(expected, version); await subscription.unsubscribe(); current(expected, version); }
    }
    if (cleanupError) throw cleanupError;
    pendingCleanup = null; publish({ cleanupPending: false });
    });
  } catch (error) { if (owner === expected && operation === version) publish({ message: (localCleared ? 'Notifications are off in this worker. Server cleanup may need a retry. ' : 'Notifications could not be fully disabled. Retry cleanup or revoke this site’s notification permission. ') + (error as Error).message }); throw error; }
  finally { if (owner === expected && operation === version) publish({ busy: false }); }
}
