import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
async function fixture(page: Page) {
  const source = readFileSync(new URL('../../lib/matrix.ts', import.meta.url), 'utf8');
  const names = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(match => match[1]);
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: names.map(name => `export const ${name}=(...args)=>{const f=window.readFixture;if('${name}'==='getMatrixClient')return f?.client;if('${name}'==='onMatrixUpdate'){f.listeners.add(args[0]);return()=>f.listeners.delete(args[0]);}throw new Error('Unexpected Matrix boundary: ${name}');};`).join('\n') }));
  await page.route('**/read-state-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root" style="max-width:340px;padding:20px"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await (await import("/tests/browser/fixtures/read-state.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/read-state-test'); await expect(page.getByRole('button', { name: 'Mark all read', exact: true })).toBeVisible();
}
test('actual channel navigation and DM badges distinguish highlights, retain real totals, and honor mute/focus/manual markers', async ({ page }) => {
  await fixture(page); const general = page.getByRole('button', { name: /^General/ });
  await expect(general.getByLabel('8 unread notifications', { exact: true })).toHaveText('8'); await expect(general.getByLabel('2 unread mentions and highlights', { exact: true })).toHaveText('@2');
  await expect(page.getByLabel('120 unread notifications', { exact: true })).toHaveText('99+'); await expect(page.getByLabel('105 unread mentions and highlights', { exact: true })).toHaveText('@99+');
  await expect(page.getByLabel('Manually marked unread', { exact: true })).toHaveCount(1); await expect(page.getByRole('button', { name: /^Manual marker/ }).locator('.unread-count')).toHaveCount(0);
  await page.getByLabel('Mute badges', { exact: true }).check(); await expect(page.locator('.mention-count,.unread-count,.manual-unread')).toHaveCount(0);
  await page.getByLabel('Mute badges', { exact: true }).uncheck(); await page.getByLabel('Focus mode', { exact: true }).check(); await expect(page.locator('.mention-count,.unread-count,.manual-unread')).toHaveCount(0);
  await page.getByLabel('Focus mode', { exact: true }).uncheck(); await page.evaluate(() => (window as any).readFixture.channel.setUnreadNotificationCount('highlight', 3)); await expect(page.getByLabel('3 unread mentions and highlights', { exact: true })).toHaveText('@3');
});
test('button reports partial native failure honestly and an explicit retry succeeds without requesting history', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { (window as any).readFixture.failed = true; }); await page.getByRole('button', { name: 'Mark all read', exact: true }).click();
  await expect(page.locator('[data-sonner-toast][data-front="true"]')).toContainText('Marked 2 conversations read through the events loaded when you started. 1 receipt failed');
  await page.evaluate(() => { (window as any).readFixture.failed = false; }); await page.getByRole('button', { name: 'Mark all read', exact: true }).click(); await expect(page.locator('[data-sonner-toast][data-front="true"]')).toContainText('Marked 2 conversations read through the events loaded when you started.');
  const calls = await page.evaluate(() => (window as any).readFixture.calls); expect(calls.every((call: any) => call.path.includes('/receipt/m.read.private/') || call.path.includes('/account_data/'))).toBe(true); expect(calls.filter((call: any) => call.path.includes('/receipt/')).every((call: any) => Object.keys(call.body).length === 0)).toBe(true);
});
test('global shortcut respects composition, repeat, dialogs and in-flight coalescing while preserving composer text', async ({ page }) => {
  await fixture(page); const composer = page.getByRole('textbox', { name: 'Composer' }); await composer.fill('Keep this draft');
  await composer.evaluate(element => { for (const extra of [{ isComposing: true }, { repeat: true }]) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', code: 'KeyR', altKey: true, shiftKey: true, bubbles: true, ...extra })); }); expect(await page.evaluate(() => (window as any).readFixture.batches)).toBe(0);
  await page.keyboard.press('Control+/'); await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible(); await page.keyboard.press('Alt+Shift+R'); expect(await page.evaluate(() => (window as any).readFixture.batches)).toBe(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await expect(composer).toBeFocused();
  await page.evaluate(() => { const f = (window as any).readFixture; const gate = new Promise<void>(resolve => f.release = resolve); f.beforeReceipt = () => gate; });
  await page.keyboard.press('Alt+Shift+R'); await expect(page.getByRole('button', { name: 'Marking conversations read…' })).toBeDisabled(); await page.keyboard.press('Alt+Shift+R'); expect(await page.evaluate(() => (window as any).readFixture.batches)).toBe(1);
  await page.evaluate(() => (window as any).readFixture.release()); await expect(page.getByRole('button', { name: 'Mark all read', exact: true })).toBeEnabled(); await expect(composer).toHaveValue('Keep this draft');
});
test('A to B to A during an outstanding action suppresses old results and further receipts, then allows current consent', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { const f = (window as any).readFixture; const gate = new Promise<void>(resolve => f.release = resolve); f.beforeReceipt = () => gate; });
  await page.getByRole('button', { name: 'Mark all read', exact: true }).click(); await expect.poll(() => page.evaluate(() => (window as any).readFixture.receipts)).toBe(1);
  await page.evaluate(() => { const f = (window as any).readFixture; f.setDevice('B', false); f.setDevice('A'); f.release(); }); await expect(page.getByRole('button', { name: 'Mark all read', exact: true })).toBeEnabled(); await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).readFixture.receipts)).toBe(1); await page.evaluate(() => { (window as any).readFixture.beforeReceipt = null; }); await page.getByRole('button', { name: 'Mark all read', exact: true }).click(); await expect(page.locator('[data-sonner-toast]')).toContainText('Marked 3 conversations');
});
test('stale visible button and shortcut cannot target a replacement account before its next render', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { const f = (window as any).readFixture; f.setDevice('B', false); f.setDevice('A', false); });
  await page.getByRole('button', { name: 'Mark all read', exact: true }).click(); await page.keyboard.press('Alt+Shift+R'); expect(await page.evaluate(() => (window as any).readFixture.batches)).toBe(0);
  await page.evaluate(() => (window as any).readFixture.emit()); await page.getByRole('button', { name: 'Mark all read', exact: true }).click(); await expect(page.locator('[data-sonner-toast]')).toContainText('Marked 3 conversations');
});
