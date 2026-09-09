import { expect, test } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=fn=>{window.listeners.add(fn);return()=>window.listeners.delete(fn)};' }));
  await page.route('**/server-nickname-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/server-nickname.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/server-nickname-test');
});
test('moderator nickname changes only visible server name and removal restores the member profile', async ({ page }) => {
  await expect(page.getByTestId('visible-name')).toHaveText('Member chosen name');
  await page.getByLabel('Server nickname', { exact: true }).fill('Managed name');
  await page.getByRole('button', { name: 'Save server nickname', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Server nickname saved.' })).toBeVisible();
  await expect(page.getByTestId('visible-name')).toHaveText('Managed name');
  await expect(page.getByText('Original member bio')).toBeVisible();
  await expect(page.getByLabel('Matrix account')).toHaveValue('@target:test');
  await page.getByRole('button', { name: 'Use member’s chosen name' }).click();
  await expect(page.getByTestId('visible-name')).toHaveText('Member chosen name');
  const writes = await page.evaluate(() => (window as any).writes);
  expect(writes.map((value: any) => value.type)).toEqual(['io.tavern.server.nickname', 'io.tavern.server.nickname']);
  expect(writes[1].content).toEqual({ version: 1, name: null, 'io.tavern.previous_event': '$saved1' });
});
test('concurrent nickname keeps the draft until explicit reload and fresh target promotion denies a write', async ({ page }) => {
  await page.getByLabel('Server nickname', { exact: true }).fill('Preserved draft');
  await page.evaluate(() => (window as any).concurrentNickname());
  await page.getByRole('button', { name: 'Save server nickname', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed elsewhere');
  await expect(page.getByLabel('Server nickname', { exact: true })).toHaveValue('Preserved draft');
  expect(await page.evaluate(() => (window as any).writes.length)).toBe(0);
  await page.getByRole('button', { name: 'Reload current nickname' }).click();
  await expect(page.getByLabel('Server nickname', { exact: true })).toHaveValue('Other moderator nickname');
  await page.getByLabel('Server nickname', { exact: true }).fill('Denied after promotion');
  await page.evaluate(() => { (window as any).promote = true; });
  await page.getByRole('button', { name: 'Save server nickname', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('authority changed');
  expect(await page.evaluate(() => (window as any).writes.length)).toBe(0);
});
