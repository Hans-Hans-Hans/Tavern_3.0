import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const mutateMatrixAccountData=()=>{throw new Error("Unexpected account write")};export const getMatrixClient=()=>window.overviewFixture?.client;export const onMatrixUpdate=fn=>{window.overviewFixture.listeners.add(fn);return()=>window.overviewFixture.listeners.delete(fn)};' }));
  await page.route(url => url.pathname === '/app/community-settings.tsx', route => route.fulfill({ contentType: 'text/javascript', body: 'export const CommunityImage=()=>null;' }));
  await page.route('**/server-overview-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/server-overview.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/server-overview-test'); await expect(page.getByRole('heading', { name: 'Make yourself at home' })).toBeVisible(); expect(errors).toEqual([]);
}

test('setup progress follows synced state and opening steps preserves editor drafts', async ({ page }) => {
  await fixture(page); await expect(page.getByText('0 of 5 suggestions complete')).toBeVisible();
  await page.getByRole('button', { name: 'Set up your team', exact: true }).click();
  await page.getByLabel('roles draft').fill('Unsubmitted role');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.getByText('0 of 5 suggestions complete')).toBeVisible();
  await page.evaluate(() => { const f = (window as any).overviewFixture; f.state['m.room.avatar'] = { url: 'mxc://local/icon' }; f.state['m.room.topic'] = { topic: 'Our saved description' }; f.state['m.space.child'] = { via: ['local'] }; f.sync(); });
  await expect(page.getByText('2 of 5 suggestions complete')).toBeVisible();
  await page.getByRole('button', { name: 'Set up your team', exact: true }).click();
  await expect(page.getByLabel('roles draft')).toHaveValue('Unsubmitted role');
});

test('owner guide can be hidden and stale-account actions do not run', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Hide setup guide' }).click();
  await expect(page.getByRole('button', { name: 'Bring someone along' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show setup guide' }).click();
  await page.evaluate(() => (window as any).overviewFixture.switchAccount());
  await page.getByRole('button', { name: 'Bring someone along' }).click();
  expect(await page.evaluate(() => (window as any).overviewFixture.actions)).toEqual([]);
});

test('non-owner never receives the owner setup actions', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).overviewFixture; f.state['io.tavern.roles'].owner = '@another:local'; f.sync(); });
  await expect(page.getByRole('heading', { name: 'Make yourself at home' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bring someone along' })).toHaveCount(0);
});

test('overview remains usable on a narrow phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 }); await fixture(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  for (const button of await page.locator('.server-overview button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
