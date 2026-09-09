import { test, expect } from '@playwright/test';
test('unified emoji picker supports tones, durable favorites/frequency, keyboard search and server emoji', async ({ page }) => {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=()=>()=>{};export const matrixApi=async()=>({});' }));
  await page.route('**/test-emoji-image', route => route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64') }));
  await page.route('**/emoji-picker-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/emoji-picker.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/emoji-picker-test'); await page.getByRole('button', { name: 'People', exact: true }).click(); await page.getByRole('combobox', { name: 'Emoji skin tone' }).selectOption('🏽');
  await page.getByRole('button', { name: 'thumbs up like yes', exact: true }).click(); await page.getByRole('button', { name: 'thumbs up like yes', exact: true }).click();
  expect(await page.evaluate(() => (window as any).choices)).toEqual(['👍🏽', '👍🏽']);
  await page.getByRole('button', { name: 'Edit favorites' }).click(); await page.getByRole('button', { name: 'thumbs up like yes — add favorite', exact: true }).click(); await page.getByRole('button', { name: 'Done with favorites' }).click();
  await page.getByRole('button', { name: 'Favorites', exact: true }).click(); await expect(page.locator('[data-emoji-choice]')).toHaveCount(1); await expect(page.locator('[data-emoji-choice]')).toHaveText('👍🏽');
  await page.getByRole('button', { name: 'Server', exact: true }).click(); await page.getByRole('button', { name: ':cheers:', exact: true }).click(); expect(await page.evaluate(() => (window as any).choices)).toContain('custom:mxc://local/cheers');
  await page.getByRole('searchbox', { name: 'Search emoji', exact: true }).fill('beer'); await expect(page.locator('[data-emoji-choice]')).toHaveCount(1); await page.locator('[data-emoji-choice]').focus(); await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as any).choices)).toContain('🍺');
  await page.reload(); await page.getByRole('button', { name: 'Frequently Used', exact: true }).click(); await expect(page.locator('[data-emoji-choice]').first()).toHaveText('👍🏽');
  await page.getByRole('button', { name: 'Favorites', exact: true }).click(); await expect(page.locator('[data-emoji-choice]')).toHaveText('👍🏽');
});
