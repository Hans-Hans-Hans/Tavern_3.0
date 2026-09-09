import { test, expect, type Page } from '@playwright/test';
async function fixture(page: Page) {
  await page.clock.install();
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=fn=>{window.listeners.add(fn);return()=>window.listeners.delete(fn)};' }));
  await page.route(url => url.pathname === '/lib/server-afk.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const conferenceAfk=()=>window.afk;' }));
  await page.route('**/conference-idle-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/conference-idle.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/conference-idle-test'); await expect(page.getByRole('checkbox')).toBeVisible();
}
test('idle is opt-in, warns, leaves exactly once and opens an AFK channel only after a user action', async ({ page }) => {
  await fixture(page); const toggle = page.getByRole('checkbox'); await expect(toggle).not.toBeChecked();
  await page.clock.fastForward(3600000); expect(await page.evaluate(() => (window as any).leaveCount)).toBe(0);
  await toggle.check(); await page.clock.fastForward(270000); await expect(page.getByRole('status')).toContainText('Leaving in 30 seconds');
  await page.clock.fastForward(30000); await expect(page.getByText('Conference left after inactivity.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).leaveCount)).toBe(1); expect(new URL(page.url()).hash).toBe('');
  await page.getByRole('button', { name: 'Open AFK channel', exact: true }).click(); expect(new URL(page.url()).hash).toBe('#room=!afk%3Alocal');
  expect(await page.evaluate(() => (window as any).captureCount)).toBe(0);
});
test('actual widget interaction and Stay in conference reset the idle warning', async ({ page }) => {
  await fixture(page); await page.getByRole('checkbox').check(); await page.clock.fastForward(270000);
  await expect(page.getByRole('status')).toContainText('Leaving in');
  await page.frameLocator('iframe').getByRole('button', { name: 'Widget control' }).click(); await expect(page.getByRole('status')).toHaveCount(0);
  await page.clock.fastForward(270000);
  // Moving the pointer toward this button is itself activity and can dismiss
  // the warning before click. Keyboard activation has no preceding mouse move.
  await page.getByRole('button', { name: 'Stay in conference' }).press('Enter');
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.clock.fastForward(290000); expect(await page.evaluate(() => (window as any).leaveCount)).toBe(0);
});
test('new calls and server policy changes require renewed opt-in and stale account callbacks cannot leave', async ({ page }) => {
  await fixture(page); await page.getByRole('checkbox').check(); await page.evaluate(() => (window as any).replaceCall()); await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Change server timeout' }).click(); await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Change account' }).click(); await expect(page.getByRole('checkbox')).not.toBeChecked(); await page.clock.fastForward(600000); await page.clock.fastForward(30000);
  expect(await page.evaluate(() => (window as any).leaveCount)).toBe(0); expect(await page.evaluate(() => (window as any).captureCount)).toBe(0);
});
test('authoritative call replacement or closing before React commits prevents stale expiry', async ({ page }) => {
  for (const action of ['replaceBeforeRender', 'closeBeforeRender']) {
    await fixture(page); await page.getByRole('checkbox').check(); await page.clock.fastForward(270000);
    await page.evaluate(action => (window as any)[action](), action); await page.clock.fastForward(30000);
    expect(await page.evaluate(() => (window as any).leaveCount)).toBe(0);
    await expect(page.getByText('Conference left after inactivity.', { exact: true })).toHaveCount(0);
  }
});
test('late leave resolution and an old destination button cannot interfere with a new call', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { (window as any).delayLeave = true; }); await page.getByRole('checkbox').check();
  await page.clock.fastForward(270000); await page.clock.fastForward(30000); expect(await page.evaluate(() => (window as any).leaveCount)).toBe(1);
  await page.evaluate(() => { const w = window as any; w.replaceBeforeRender(); w.finishLeave(); });
  await expect(page.getByText('Conference left after inactivity.', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).authoritativeConference().roomId)).toBe('!new:local');
  await fixture(page); await page.getByRole('checkbox').check(); await page.clock.fastForward(270000); await page.clock.fastForward(30000);
  await expect(page.getByRole('button', { name: 'Open AFK channel' })).toBeVisible(); await page.evaluate(() => (window as any).replaceBeforeRender());
  await page.getByRole('button', { name: 'Open AFK channel' }).click(); expect(new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(() => (window as any).authoritativeConference().roomId)).toBe('!new:local');
});
