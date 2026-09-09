import { expect, test, type Page } from '@playwright/test';

function state(roomId: string) {
  return { roomId, userId: '@guest:local', available: true, local: { muted: false, deafened: false }, effective: { muted: false, deafened: false }, permissions: { mute: true, deafen: true }, eventId: null as string | null, revision: 'a'.repeat(64),
    scopes: [{ roomId: '!channel:local', name: 'General', kind: 'channel' }, { roomId: '!server:local', name: 'Tavern', kind: 'server' }], enforcement: { status: 'idle', checkedAt: null, devices: 0 } };
}
async function fixture(page: Page, action = 'muted', configure?: (backend: any) => void) {
  const backend = { states: { '!channel:local': state('!channel:local'), '!server:local': state('!server:local') } as Record<string, ReturnType<typeof state>>, reads: [] as string[], writes: [] as any[], reject: 0, enforcement: 'pending', beforeGet: null as (() => Promise<void>) | null, beforePost: null as (() => Promise<void>) | null };
  configure?.(backend);
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.audioFixture?.client;export const onMatrixUpdate=fn=>{window.audioFixture.listeners.add(fn);return()=>window.audioFixture.listeners.delete(fn)};' }));
  await page.route('**/api/calls/audio/**', async route => {
    const roomId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[4]);
    if (route.request().method() === 'GET') {
      backend.reads.push(roomId); const result = structuredClone(backend.states[roomId]); await backend.beforeGet?.();
      return route.fulfill({ json: result });
    }
    const body = route.request().postDataJSON(); backend.writes.push({ roomId, body }); await backend.beforePost?.();
    if (backend.reject) return route.fulfill({ status: backend.reject, json: { error: 'Audio permissions changed. Reload the current settings.' } });
    const result = backend.states[roomId]; Object.assign(result.local, body.change); Object.assign(result.effective, result.local);
    result.eventId = '$audio-' + backend.writes.length; result.revision = 'b'.repeat(64); result.enforcement.status = backend.enforcement;
    return route.fulfill({ json: { saved: true, ...result } });
  });
  await page.route('**/audio-moderation-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/conference-audio-moderation.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/audio-moderation-test?action=' + action);
  return backend;
}

test('server scope writes one mute flag and reports pending enforcement without changing the independent deafen flag', async ({ page }) => {
  const backend = await fixture(page, 'muted', b => { b.states['!server:local'].local.deafened = true; b.states['!server:local'].effective.deafened = true; });
  await page.getByLabel('Apply in', { exact: true }).selectOption('!server:local');
  await page.getByRole('button', { name: 'Apply server mute', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Waiting for the call service');
  expect(backend.writes).toEqual([{ roomId: '!server:local', body: { change: { muted: true }, revision: 'a'.repeat(64), confirmation: '@guest:local' } }]);
  expect(backend.states['!server:local'].local.deafened).toBe(true);
  await expect(page.getByRole('button', { name: 'Remove server mute', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).audioFixture.captures)).toBe(0);
});

test('clearing deafen preserves mute and reports the confirmed device count', async ({ page }) => {
  const backend = await fixture(page, 'deafened', b => { b.enforcement = 'confirmed'; b.states['!channel:local'].local = { muted: true, deafened: true }; b.states['!channel:local'].effective = { muted: true, deafened: true }; b.states['!channel:local'].enforcement.devices = 2; });
  await page.getByRole('button', { name: 'Remove server deafen', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('confirmed for 2 connected devices');
  expect(backend.writes[0].body.change).toEqual({ deafened: false }); expect(backend.states['!channel:local'].local.muted).toBe(true);
});

test('inherited restrictions and backend permissions remain explicit; failed writes require refresh', async ({ page }) => {
  const backend = await fixture(page, 'muted', b => { b.states['!channel:local'].effective.muted = true; b.states['!channel:local'].permissions.mute = false; });
  await expect(page.getByText('A restriction from another scope still applies.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply server mute', exact: true })).toHaveCount(0);
  await page.getByLabel('Apply in', { exact: true }).selectOption('!server:local'); backend.reject = 409;
  await page.getByRole('button', { name: 'Apply server mute', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Refresh the current state');
  await expect(page.getByRole('button', { name: 'Apply server mute', exact: true })).toBeDisabled();
  backend.reject = 0; backend.states['!server:local'].revision = 'c'.repeat(64);
  await page.getByRole('button', { name: 'Refresh audio status', exact: true }).click();
  await page.getByRole('button', { name: 'Apply server mute', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved.'); expect(backend.writes.at(-1).body.revision).toBe('c'.repeat(64));
});

for (const change of ['changeAccount', 'leaveRoom', 'closeCall', 'replaceCall']) test(`${change} discards a delayed read and closes the old audio controls`, async ({ page }) => {
  let finish!: () => void;
  const backend = await fixture(page, 'muted', b => { b.beforeGet = () => new Promise<void>(resolve => { finish = resolve; }); });
  await expect.poll(() => backend.reads.length).toBe(1);
  await page.evaluate(change => (window as any).audioFixture[change](), change); finish();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(backend.writes).toEqual([]);
});

test('an account change during save cannot display old success or submit to the replacement session', async ({ page }) => {
  let finish!: () => void;
  const backend = await fixture(page, 'muted', b => { b.beforePost = () => new Promise<void>(resolve => { finish = resolve; }); });
  await page.getByRole('button', { name: 'Apply server mute', exact: true }).click();
  await expect.poll(() => backend.writes.length).toBe(1);
  await page.evaluate(() => (window as any).audioFixture.changeAccount()); finish();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByText('Saved.', { exact: false })).toHaveCount(0);
  expect(backend.writes).toHaveLength(1);
});

test('audio controls fit a narrow viewport and remain unavailable until configured', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 550 });
  const backend = await fixture(page, 'muted', b => { b.states['!channel:local'].available = false; });
  await expect(page.getByRole('button', { name: 'Apply server mute', exact: true })).toBeDisabled();
  await expect(page.getByText('Adding server audio restrictions is unavailable.', { exact: false })).toBeVisible();
  const dialog = page.getByRole('dialog');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(backend.writes).toHaveLength(0);
});

test('authorized clearing remains available when the call-service extension is disabled', async ({ page }) => {
  const backend = await fixture(page, 'muted', b => { b.states['!channel:local'].available = false; b.states['!channel:local'].local.muted = true; b.states['!channel:local'].effective.muted = true; });
  await page.getByRole('button', { name: 'Remove server mute', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Waiting for the call service');
  expect(backend.writes[0].body.change).toEqual({ muted: false });
  await expect(page.getByRole('button', { name: 'Apply server mute', exact: true })).toBeDisabled();
});

test('restoring muted publication reports a required rejoin instead of confirmed permissions', async ({ page }) => {
  await fixture(page, 'muted', b => { b.states['!channel:local'].local.muted = true; b.states['!channel:local'].enforcement.rejoinRequired = true; });
  await page.getByRole('button', { name: 'Remove server mute', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved\./ })).toContainText('needs to leave and rejoin');
  await expect(page.getByText('Audio permissions confirmed', { exact: false })).toHaveCount(0);
});
