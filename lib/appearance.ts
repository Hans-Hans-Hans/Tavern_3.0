import { ClientEvent, type MatrixClient } from 'matrix-js-sdk';
import { getMatrixClient } from './matrix';
import { accountArtworkOwner } from './api';
export const appearanceKey = 'io.tavern.appearance';
export type AppearancePreferences = { version: 1; theme: 'system' | 'light' | 'dark'; font: 'system' | 'readable' | 'monospace'; chatScale: number; memberList: boolean; reducedMotion: 'system' | 'always'; saturation: number; density: 'comfortable' | 'compact'; messageSpacing: 'auto' | 'compact' | 'comfortable' | 'spacious' };
const bounded = (value: unknown, low: number, high: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(high, Math.max(low, value)) * 100) / 100 : fallback;
export function normalizeAppearance(value: any): AppearancePreferences { return { version: 1, theme: value?.theme === 'light' || value?.theme === 'dark' ? value.theme : 'system', font: value?.font === 'readable' || value?.font === 'monospace' ? value.font : 'system', chatScale: bounded(value?.chatScale, .85, 1.5, 1), memberList: value?.memberList !== false, reducedMotion: value?.reducedMotion === 'always' ? 'always' : 'system', saturation: bounded(value?.saturation, 0, 1, 1), density: value?.density === 'compact' ? 'compact' : 'comfortable', messageSpacing: ['compact', 'comfortable', 'spacious'].includes(value?.messageSpacing) ? value.messageSpacing : 'auto' }; }
export function readAppearance(c: MatrixClient | null = getMatrixClient()) { const saved = c?.getAccountData(appearanceKey as any)?.getContent(); return normalizeAppearance(saved || c?.getAccountData('io.harbor.preferences' as any)?.getContent()); }
export function resolvedTheme(preference: AppearancePreferences['theme'], systemDark: boolean) { return preference === 'system' ? systemDark ? 'dark' : 'light' : preference; }
const colorProperties = ['--primary', '--accent', '--accent-foreground', '--ring', '--sidebar-accent', '--sidebar-accent-foreground', '--sidebar-primary', '--mint-surface', '--mint-text'];
// Desaturate UI colors without modifying photographs, video, or custom server artwork.
export function desaturateColor(value: string, saturation: number) { const match = value.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[, ]+\s*(\d+(?:\.\d+)?)[, ]+\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*([.\d]+))?\s*\)$/); if (!match) return value; const [r, g, b] = match.slice(1, 4).map(Number), gray = .2126 * r + .7152 * g + .0722 * b, mix = (x: number) => Math.round(gray + (x - gray) * saturation); return `rgba(${mix(r)}, ${mix(g)}, ${mix(b)}, ${match[4] || 1})`; }
let active: MatrixClient | null = null, darkQuery: MediaQueryList | null = null, motionQuery: MediaQueryList | null = null, applied = '';
export function applyAppearance(value: AppearancePreferences) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const fingerprint = JSON.stringify([value, root.dataset.accent, window.matchMedia('(prefers-color-scheme: dark)').matches, window.matchMedia('(prefers-reduced-motion: reduce)').matches]);
  if (fingerprint === applied) return; applied = fingerprint;
  root.dataset.theme = resolvedTheme(value.theme, window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.density = value.density; root.dataset.messageSpacing = value.messageSpacing;
  root.dataset.tavernFont = value.font; root.dataset.memberList = value.memberList ? 'visible' : 'hidden'; root.dataset.reduceMotion = value.reducedMotion === 'always' || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'true' : 'false';
  root.style.setProperty('--tavern-chat-scale', String(value.chatScale));
  for (const property of colorProperties) root.style.removeProperty(property);
  if (value.saturation < 1) { const computed = getComputedStyle(root), probe = document.createElement('span'); probe.style.display = 'none'; root.appendChild(probe); try { for (const property of colorProperties) { probe.style.color = computed.getPropertyValue(property); root.style.setProperty(property, desaturateColor(getComputedStyle(probe).color, value.saturation)); } } finally { probe.remove(); } }
}
const refresh = () => applyAppearance(readAppearance(active));
const accountUpdated = (event: { getType(): string }) => { if (event.getType() === appearanceKey || event.getType() === 'io.harbor.preferences') refresh(); };
export function initializeAppearance(c: MatrixClient) { resetAppearance(); active = c; darkQuery = window.matchMedia('(prefers-color-scheme: dark)'); motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)'); darkQuery.addEventListener('change', refresh); motionQuery.addEventListener('change', refresh); c.on(ClientEvent.AccountData, accountUpdated); refresh(); }
export function resetAppearance() { active?.off(ClientEvent.AccountData, accountUpdated); darkQuery?.removeEventListener('change', refresh); motionQuery?.removeEventListener('change', refresh); active = null; darkQuery = null; motionQuery = null; applied = ''; if (typeof document !== 'undefined') applyAppearance(normalizeAppearance(undefined)); }
export function appearanceOwner(c = getMatrixClient()) {
  return { client: c, user: c?.getUserId?.(), device: c?.getDeviceId?.(), account: accountArtworkOwner() };
}
export function isAppearanceOwner(owner: ReturnType<typeof appearanceOwner>) {
  return !!owner.client && getMatrixClient() === owner.client && owner.client.getUserId?.() === owner.user
    && owner.client.getDeviceId?.() === owner.device && accountArtworkOwner() === owner.account;
}
const writes = new WeakMap<MatrixClient, Promise<unknown>>();
export function saveAppearance(change: Partial<AppearancePreferences>, c = getMatrixClient()) {
  if (!c) throw new Error('Sign in to save appearance preferences.');
  const owner = appearanceOwner(c), requested = { ...change };
  const check = () => { if (!isAppearanceOwner(owner)) throw new Error('Your account changed. Reopen appearance settings.'); };
  const task = (writes.get(c) || Promise.resolve()).catch(() => {}).then(async () => {
    check();
    const saved = await c.getAccountDataFromServer(appearanceKey as any); check();
    const next = normalizeAppearance({ ...readAppearance(c), ...saved, ...requested });
    await c.setAccountData(appearanceKey as any, next as any); check();
    applyAppearance(next); return next;
  });
  writes.set(c, task); return task;
}
