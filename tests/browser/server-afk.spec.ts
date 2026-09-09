import { test, expect, type Page } from '@playwright/test';
async function fixture(page: Page, query = '') {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=fn=>{window.listeners.add(fn);return()=>window.listeners.delete(fn)};' }));
  await page.route('**/server-afk-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/server-afk.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/server-afk-test?' + query);
}
test('server AFK UI saves a valid voice destination and timeout with native CAS', async ({ page }) => {
  await fixture(page);
  const destination = page.getByRole('combobox', { name: 'AFK destination' }); await expect(destination.getByRole('option')).toHaveCount(2);
  await destination.selectOption('!voice:local'); await page.getByRole('combobox', { name: 'AFK timeout' }).selectOption('600'); await page.getByRole('button', { name: 'Save AFK settings' }).click();
  await expect(page.getByRole('status')).toHaveText('AFK settings saved.');
  expect(await page.evaluate(() => (window as any).writes)).toEqual([['!server:local', 'io.tavern.server.afk', { version: 1, channelId: '!voice:local', timeoutSeconds: 600, 'io.tavern.previous_event': null }, '']]);
  await expect(page.getByText('This does not move members automatically or monitor speech.', { exact: false })).toBeVisible();
});
test('native power alone does not expose AFK editing and permission loss while saving makes no write', async ({ page }) => {
  await fixture(page, 'restricted'); await expect(page.getByRole('button', { name: 'Save AFK settings' })).toHaveCount(0);
  await fixture(page); await page.getByRole('combobox', { name: 'AFK destination' }).selectOption('!voice:local');
  await page.evaluate(() => { const w = window as any; w.beforeRead = () => { w.server.power.users[w.actor] = 0; w.beforeRead = null; }; });
  await page.getByRole('button', { name: 'Save AFK settings' }).click(); await expect(page.getByRole('alert')).toContainText('Permissions or memberships changed');
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
});
