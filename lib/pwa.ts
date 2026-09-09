type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type PwaState = { online: boolean; installAvailable: boolean; installed: boolean; updateAvailable: boolean; applying: boolean; message: string };
let state: PwaState = { online: typeof navigator === 'undefined' || navigator.onLine, installAvailable: false, installed: false, updateAvailable: false, applying: false, message: '' };
let started = false, deferredInstall: InstallPrompt | null = null, registration: ServiceWorkerRegistration | null = null, reloadAllowed = false, reloadTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const update = (patch: Partial<PwaState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
async function checkConnection() {
  if (!navigator.onLine) { update({ online: false }); return false; }
  try { const response = await fetch('/health', { method: 'HEAD', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000) }); update({ online: response.ok }); return response.ok; }
  catch { update({ online: false }); return false; }
}
export const pwaSnapshot = () => state;
export function subscribePwa(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** AuthGateway disables reloads during login, setup, account sessions and form submissions. */
export function setPwaReloadAllowed(allowed: boolean) { reloadAllowed = allowed; }
export function pwaUpdateLocked() { return state.applying; }

async function safeToReload() {
  if (!reloadAllowed) return false;
  const [matrix, media] = await Promise.all([import('./matrix'), import('./media-session')]);
  return reloadAllowed && !matrix.matrixSessionInProgress() && media.mediaOwner() === null;
}

function applying() {
  if (reloadTimer) clearTimeout(reloadTimer);
  update({ applying: true, message: '' });
  reloadTimer = setTimeout(() => update({ applying: false, message: 'The update did not finish. Close other Tavern windows and try again.' }), 15000);
}

export function initializePwa() {
  if (started || typeof window === 'undefined') return;
  started = true;
  void checkConnection();
  const standalone = matchMedia('(display-mode: standalone)');
  update({ installed: standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true });
  standalone.addEventListener('change', () => update({ installed: standalone.matches }));
  window.addEventListener('online', () => { void checkConnection().then(online => { if (online) void import('./matrix').then(matrix => matrix.getMatrixClient()?.retryImmediately()); }); });
  window.addEventListener('offline', () => update({ online: false }));
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstall = event as InstallPrompt; update({ installAvailable: true }); });
  window.addEventListener('appinstalled', () => { deferredInstall = null; update({ installed: true, installAvailable: false }); });
  // Vite's development modules are deliberately never cached.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (state.applying) location.reload(); });
  navigator.serviceWorker.addEventListener('message', event => {
    const source = event.source as ServiceWorker | null;
    if (!source || source.scriptURL !== new URL('/sw.js', location.origin).href) return;
    if (event.data?.type === 'TAVERN_UPDATE_BLOCKED') {
      if (reloadTimer) clearTimeout(reloadTimer);
      update({ applying: false, message: String(event.data.reason || 'The update could not be applied.').slice(0, 220) });
    } else if (event.data?.type === 'TAVERN_UPDATE_CHECK') {
      void safeToReload().then(safe => { if (safe) applying(); source.postMessage({ type: 'TAVERN_UPDATE_READY', id: event.data.id, safe }); }).catch(() => source.postMessage({ type: 'TAVERN_UPDATE_READY', id: event.data.id, safe: false }));
    }
  });
  void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(value => {
    registration = value;
    const check = () => update({ updateAvailable: !!value.waiting });
    check();
    value.addEventListener('updatefound', () => { const worker = value.installing; worker?.addEventListener('statechange', () => { if (worker.state === 'installed') check(); }); });
    let lastChecked = Date.now();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastChecked > 60000) { lastChecked = Date.now(); void value.update().catch(() => {}); } });
  }).catch(() => update({ message: 'Offline app storage is unavailable. Tavern still works while connected.' }));
}

export async function installTavern() {
  if (!deferredInstall) return false;
  const prompt = deferredInstall; deferredInstall = null;
  await prompt.prompt(); const choice = await prompt.userChoice;
  update({ installAvailable: false, installed: choice.outcome === 'accepted' || state.installed });
  return true;
}

export async function applyAppUpdate() {
  if (!registration?.waiting || state.applying) return;
  try {
    if (!await safeToReload()) { update({ message: 'Sign out and finish calls in every Tavern window before updating.' }); return; }
    applying(); registration.waiting.postMessage({ type: 'TAVERN_UPDATE_REQUEST' });
  } catch { update({ applying: false, message: 'The update could not be prepared. Reconnect and try again.' }); }
}

export async function reconnectTavern() {
  if (!await checkConnection()) return;
  try {
    const matrix = await import('./matrix');
    if (matrix.getMatrixClient()) matrix.getMatrixClient()!.retryImmediately();
    else window.dispatchEvent(new Event('tavern:reconnect'));
  } catch { update({ message: 'Tavern could not reconnect. Check your connection and try again.' }); }
}
