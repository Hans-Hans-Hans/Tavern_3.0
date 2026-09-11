import { expect, test, type Page } from '@playwright/test';
import { routeVoiceAvatar } from './voice-fixture-routes';

const self = '@moderator:local', guest = '@guest:local';
function audioState(roomId: string, userId: string) {
  return { roomId, userId, available: true, local: { muted: false, deafened: false }, effective: { muted: false, deafened: false },
    permissions: { mute: userId !== self, deafen: userId !== self }, eventId: null as string | null, revision: 'a'.repeat(64),
    scopes: [{ roomId, name: 'Call room', kind: 'channel' }], enforcement: { status: 'idle', checkedAt: null, devices: 0 } };
}
async function fixture(page: Page, configure?: (backend: any) => void, managed = true) {
  await routeVoiceAvatar(page);
  const backend = { capabilities: { available: false, audioModerationAvailable: true, audioModerationControls: true }, capabilityReads: 0,
    reads: [] as { roomId: string; userId: string; device: string | undefined }[], writes: [] as any[],
    states: new Map<string, ReturnType<typeof audioState>>(),
    beforeCapability: null as (() => Promise<void>) | null,
    beforeGet: null as ((roomId: string, userId: string) => Promise<void>) | null };
  for (const room of ['!channel:local', '!other:local']) for (const user of [self, guest]) backend.states.set(room + user, audioState(room, user));
  configure?.(backend);
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const mutateMatrixAccountData=async()=>{throw new Error("Read-only voice fixture cannot write account data")};export const getMatrixClient=()=>window.audioPanelFixture?.client;export const onMatrixUpdate=fn=>{window.audioPanelFixture.listeners.add(fn);return()=>window.audioPanelFixture.listeners.delete(fn)};' }));
  await page.route(url => url.pathname === '/lib/conference.ts', route => route.fulfill({ contentType: 'text/javascript', body: `
    export async function mountConference(client,roomId,frame,onLeave,signal,onJoined,managed,onDevices){
      const f=window.audioPanelFixture;f.mounts.push(roomId);frame.srcdoc='<p>Isolated media boundary</p>';
      onJoined();onDevices({audio_enabled:true,video_enabled:true});
      const stop=async()=>{f.stops.push(roomId)};stop.setDevices=async value=>onDevices(value);return stop;
    }` }));
  await page.route('**/api/calls/capabilities', async route => { backend.capabilityReads++; const value = structuredClone(backend.capabilities); await backend.beforeCapability?.(); await route.fulfill({ json: value }); });
  await page.route('**/api/calls/audio/**', async route => {
    const parts = new URL(route.request().url()).pathname.split('/'), roomId = decodeURIComponent(parts[4]), userId = decodeURIComponent(parts[5]);
    const value = backend.states.get(roomId + userId);
    if (!value) return route.fulfill({ status: 404, json: { error: 'Unexpected fixture scope' } });
    if (route.request().method() === 'GET') {
      backend.reads.push({ roomId, userId, device: route.request().headers()['x-tavern-device'] });
      const snapshot = structuredClone(value); await backend.beforeGet?.(roomId, userId); return route.fulfill({ json: snapshot });
    }
    const body = route.request().postDataJSON(); backend.writes.push({ roomId, userId, body });
    Object.assign(value.local, body.change); Object.assign(value.effective, value.local);
    value.eventId = '$saved'; value.revision = 'b'.repeat(64); value.enforcement.status = 'pending';
    return route.fulfill({ json: { ...value, saved: true } });
  });
  await page.route('**/conference-audio-panel-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/conference-audio-panel.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/conference-audio-panel-test?managed=' + managed);
  await expect(page.getByRole('region', { name: 'Conference in Call room' })).toBeVisible();
  await expect(page.getByText('Conference active', { exact: false })).toBeVisible();
  return backend;
}
async function openMenu(page: Page, name = 'Guest') {
  await page.getByRole('button', { name, exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
}
async function openModeration(page: Page, action: 'mute' | 'deafen') {
  await openMenu(page);
  await page.getByRole('menuitem', { name: new RegExp('^Server ' + action) }).click();
  return page.getByRole('dialog', { name: 'Server ' + action + ': Guest' });
}

for (const action of ['mute', 'deafen'] as const) test(`participant menu opens actual server ${action} for the active call, independent of selected channel`, async ({ page }) => {
  const backend = await fixture(page);
  await expect.poll(() => backend.reads.some(value => value.userId === self)).toBe(true);
  await expect(page.getByRole('button', { name: 'Guest', exact: true })).toHaveCount(1);
  const dialog = await openModeration(page, action); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply server ' + action, exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Waiting for the call service');
  expect(backend.writes).toEqual([{ roomId: '!channel:local', userId: guest, body: { change: { [action === 'mute' ? 'muted' : 'deafened']: true }, revision: 'a'.repeat(64), confirmation: guest } }]);
  expect(backend.reads.every(value => value.roomId === '!channel:local' && value.device === 'D1')).toBe(true);
  expect(new URL(page.url()).hash).toBe('#room=!selected%3Alocal');
  expect(await page.evaluate(() => (window as any).audioPanelFixture.captures)).toBe(0);
});

test('capability and managed-account gates hide moderation and self has no moderation action', async ({ page }) => {
  const disabled = await fixture(page, b => { b.capabilities.audioModerationAvailable = false; b.capabilities.audioModerationControls = false; });
  await expect.poll(() => disabled.capabilityReads).toBe(1); await openMenu(page);
  await expect(page.getByRole('menuitem', { name: /^Server (mute|deafen)/ })).toHaveCount(0);
  expect(disabled.reads).toHaveLength(0);
  const unmanaged = await fixture(page, undefined, false); await openMenu(page);
  await expect(page.getByRole('menuitem', { name: /^Server (mute|deafen)/ })).toHaveCount(0);
  expect(unmanaged.capabilityReads).toBe(0); expect(unmanaged.reads).toHaveLength(0);
  await fixture(page); await openMenu(page, 'Moderator (you)');
  await expect(page.getByRole('menuitem', { name: /^Server (mute|deafen)/ })).toHaveCount(0);
});

test('inspection capability keeps authorized clearing reachable while new restrictions are unavailable', async ({ page }) => {
  const backend = await fixture(page, b => { b.capabilities.audioModerationAvailable = false; const v = b.states.get('!channel:local' + guest); v.available = false; v.local.deafened = v.effective.deafened = true; });
  const dialog = await openModeration(page, 'deafen');
  await dialog.getByRole('button', { name: 'Remove server deafen', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Apply server deafen', exact: true })).toBeDisabled();
  expect(backend.writes[0].body.change).toEqual({ deafened: false });
});

test('a replacement call discards a delayed old-room dialog and uses the new conference generation', async ({ page }) => {
  let release!: () => void;
  const backend = await fixture(page, b => { b.beforeGet = (room: string, user: string) => room === '!channel:local' && user === guest ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve(); });
  await openModeration(page, 'mute');
  await expect.poll(() => backend.reads.filter(value => value.userId === guest).length).toBe(1);
  const before = await page.evaluate(() => (window as any).audioPanelFixture.snapshot().generation);
  await page.evaluate(() => (window as any).audioPanelFixture.replaceCall()); release();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Conference in Other call' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).audioPanelFixture.snapshot().generation)).toBeGreaterThan(before);
  const dialog = await openModeration(page, 'deafen'); await dialog.getByRole('button', { name: 'Apply server deafen', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Waiting for the call service');
  expect(backend.writes).toHaveLength(1); expect(backend.writes[0].roomId).toBe('!other:local');
});

test('API A-to-B-to-A generation change closes the mounted panel and discards its delayed target response', async ({ page }) => {
  let release!: () => void;
  const backend = await fixture(page, b => { b.beforeGet = (_room: string, user: string) => user === guest ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve(); });
  await openModeration(page, 'mute'); await expect.poll(() => backend.reads.filter(value => value.userId === guest).length).toBe(1);
  await page.evaluate(() => (window as any).audioPanelFixture.changeAccount()); release();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('region', { name: /^Conference in/ })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).audioPanelFixture.snapshot().phase)).toBe('idle');
  expect(backend.writes).toHaveLength(0);
});

test('a late capability response cannot enable controls after the API account changes', async ({ page }) => {
  let release!: () => void;
  const backend = await fixture(page, b => { b.beforeCapability = () => new Promise<void>(resolve => { release = resolve; }); });
  await expect.poll(() => backend.capabilityReads).toBe(1);
  await page.evaluate(() => (window as any).audioPanelFixture.changeAccount()); release();
  await expect(page.getByRole('region', { name: /^Conference in/ })).toHaveCount(0);
  expect(backend.reads).toHaveLength(0); expect(backend.writes).toHaveLength(0);
});

test('the affected member sees authoritative pending restrictions and status disappears on account change', async ({ page }) => {
  const backend = await fixture(page, b => { const value = b.states.get('!channel:local' + self); value.effective = { muted: true, deafened: true }; value.enforcement.status = 'pending'; });
  const status = page.getByRole('status');
  await expect(status).toContainText('restricted your outgoing conference audio');
  await expect(status).toContainText('restricted the conference audio you can hear');
  await expect(status).toContainText('has not confirmed this change');
  await page.evaluate(() => (window as any).audioPanelFixture.changeAccount());
  await expect(status).toHaveCount(0); expect(backend.writes).toHaveLength(0);
});
