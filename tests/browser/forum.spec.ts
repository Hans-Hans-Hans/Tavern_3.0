import { test, expect, type Page } from '@playwright/test';
async function fixture(page: Page) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=()=>()=>{};export const matrixApi=(...args)=>window.fixtureApi(...args);export const mutateMatrixAccountData=()=>{throw new Error("Unexpected account-data write in forum fixture");};' }));
  await page.route('**/forum-test*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/forum.tsx')).mountFixture();</script></body></html>` }));
}
test('forum bounds rendered discussions, pages older posts and separates archived closed and locked filters', async ({ page }) => {
  await fixture(page); await page.goto('/forum-test'); await expect(page.locator('.forum-post')).toHaveCount(25); await expect(page.getByText('Page 1 of 3', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next discussions' }).click(); await expect(page.getByText('Page 2 of 3', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Discussion status' }).selectOption('archived'); await expect(page.locator('.forum-post')).toHaveCount(1); await page.getByRole('button', { name: 'Discussion 5', exact: true }).click(); expect(await page.evaluate(() => (window as any).opened)).toBe('$post5');
  await page.getByRole('combobox', { name: 'Discussion status' }).selectOption('closed'); await expect(page.getByRole('button', { name: 'Discussion 6', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Discussion status' }).selectOption('locked'); await expect(page.getByRole('button', { name: 'Discussion 7', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search forum posts' }).fill('missing'); await expect(page.locator('.forum-post')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Load earlier forum history' })).toBeEnabled();
});
test('empty loaded history can discover earlier forum posts', async ({ page }) => {
  await fixture(page); await page.goto('/forum-test?empty'); await page.getByRole('button', { name: 'Load earlier forum history' }).click(); await expect(page.getByRole('button', { name: 'Discussion -1', exact: true })).toBeVisible(); expect(await page.evaluate(() => (window as any).historyCalls)).toBe(1); await expect(page.getByRole('button', { name: 'Load earlier forum history' })).toHaveCount(0);
});
test('unconfirmed forum send keeps its draft and retries with the same transaction', async ({ page }) => {
  await fixture(page); await page.goto('/forum-test?empty'); await page.getByRole('button', { name: 'New discussion' }).click(); await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Preserved title'); await page.getByRole('textbox', { name: 'Post', exact: true }).fill('Preserved body'); await page.getByRole('button', { name: 'Post discussion' }).click(); await expect(page.getByRole('alert')).toContainText('not confirmed'); await expect(page.getByRole('textbox', { name: 'Post', exact: true })).toHaveValue('Preserved body'); await page.getByRole('button', { name: 'Post discussion' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  const sends = await page.evaluate(() => (window as any).submissions); expect(sends).toHaveLength(2); expect(sends[1]).toEqual(sends[0]); expect(sends[0].nonce).toBeTruthy();
});
