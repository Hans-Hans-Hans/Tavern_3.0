import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, empty = false) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const getMatrixClient=()=>window.fixtureHistory?.state.current?window.fixtureHistory.client:null;export const onMatrixUpdate=fn=>{window.fixtureHistoryListeners.add(fn);return()=>window.fixtureHistoryListeners.delete(fn)};export const loadThreadHistory=()=>window.fixtureHistoryOlder();export const threadHasOlder=()=>window.fixtureHistoryHasOlder();` }));
  await page.route('**/thread-history-test*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/thread-history.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/thread-history-test' + (empty ? '?empty' : ''));
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Thread notifications' })).toBeVisible();
}

test('the existing thread history control loads encrypted historical replies from a cached root through actual SDK timelines', async ({ page }) => {
  await fixture(page); expect(await page.evaluate(() => (window as any).fixtureInitialRootLoaded)).toBe(false);
  await expect(page.getByRole('list', { name: 'Loaded thread replies' }).getByRole('listitem')).toHaveText(['Latest encrypted reply']);
  await page.getByRole('button', { name: 'Load 50 earlier replies' }).click();
  await expect(page.getByRole('list', { name: 'Loaded thread replies' }).getByRole('listitem')).toHaveText(['First historical encrypted reply', 'Second historical encrypted reply', 'Latest encrypted reply']);
  await expect(page.getByRole('button', { name: 'Load 50 earlier replies' })).toHaveCount(0);
  const native = await page.evaluate(() => { const f = (window as any).fixtureHistory, thread = f.room.getThread(f.rootId); return { initialized: thread.initialEventsFetched, encrypted: thread.events.every((event: any) => event.isEncrypted()), requests: f.requests.filter((url: URL) => url.pathname.includes('/relations/')).map((url: URL) => ({ path: url.pathname, from: url.searchParams.get('from'), limit: url.searchParams.get('limit') })) }; });
  expect(native.initialized).toBe(true); expect(native.encrypted).toBe(true); expect(native.requests).toHaveLength(2); expect(native.requests[1].from).toBe('older-replies'); expect(native.requests[1].limit).toBe('50'); expect(native.requests.some((request: any) => request.path.includes('/m.room.message'))).toBe(false);
});

test('an empty initialized thread stays usable without a missing latest-message error', async ({ page }) => {
  await fixture(page, true); await expect(page.getByText('No replies yet.')).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Load 50 earlier replies' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).fixtureHistory.requests.filter((url: URL) => url.pathname.includes('/relations/')).length)).toBe(0);
});

test('native history denial remains an explicit retryable error in the existing thread tools', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Deny next history page' }).click(); await page.getByRole('button', { name: 'Load 50 earlier replies' }).click();
  await expect(page.getByRole('alert')).toContainText('History access was denied'); await expect(page.getByText('Latest encrypted reply', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Allow history again' }).click(); await page.getByRole('button', { name: 'Load 50 earlier replies' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.getByText('First historical encrypted reply', { exact: true })).toBeVisible();
});

test('an account change during an older page prevents late replies reaching the rendered projection', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Pause history page' }).click(); await page.getByRole('button', { name: 'Load 50 earlier replies' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixtureHistory.requests.filter((url: URL) => url.searchParams.has('from')).length)).toBe(1);
  await page.getByRole('button', { name: 'Change account' }).click(); await page.evaluate(() => (window as any).fixtureReleaseHistory());
  await expect(page.getByRole('alert')).toContainText('account or room access changed'); await expect(page.getByText('First historical encrypted reply', { exact: true })).toHaveCount(0);
});
