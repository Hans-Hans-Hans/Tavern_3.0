import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const names = [...readFileSync('lib/matrix.ts', 'utf8').matchAll(/export (?:async )?function (\w+)/g)].map(match => match[1]);

async function fixture(page: Page) {
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: names.map(name => 'export const ' + name + '=(...args)=>window.matrixBoundary(' + JSON.stringify(name) + ',args);').join('\n') }));
  await page.route('**/config.json', route => route.fulfill({ json: { homeserverUrl: 'http://127.0.0.1:5173', serverRolePolicy: true, callsEnabled: false } }));
  await page.route('**/thread-workspace-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/private-workspace.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/thread-workspace-test');
  await expect.poll(async () => { if (failures.length) throw new Error(failures.join('\n')); const button=page.locator('.profile-button'); return await button.count() ? button.textContent() : ''; }).toContain('Owner');
  await page.evaluate(() => { (window as any).deferThreadReplies = true; });
  await page.getByRole('article').filter({ hasText: 'Source message' }).hover();
  await page.getByRole('button', { name: 'Reply in thread', exact: true }).click();
  await expect(page.locator('.thread-sheet')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).threadRequests?.length || 0)).toBe(1);
}
const update = (page: Page) => page.evaluate(() => (window as any).notify());

test('actual Workspace thread refresh keeps newer replies when sync reads resolve out of order', async ({ page }) => {
  await fixture(page); await update(page);
  await expect.poll(() => page.evaluate(() => (window as any).threadRequests.length)).toBe(2);
  await page.evaluate(() => (window as any).threadRequests[1].resolve(['Newest reply']));
  await expect(page.locator('.thread-sheet')).toContainText('Newest reply');
  await page.evaluate(() => (window as any).threadRequests[0].resolve(['Stale reply']));
  await expect(page.locator('.thread-sheet')).toContainText('Newest reply'); await expect(page.locator('.thread-sheet')).not.toContainText('Stale reply');
});

test('closing and reopening the same thread fences its older request', async ({ page }) => {
  await fixture(page); await page.keyboard.press('Escape'); await expect(page.locator('.thread-sheet')).toHaveCount(0);
  await page.getByRole('article').filter({ hasText: 'Source message' }).hover();
  await page.getByRole('button', { name: 'Reply in thread', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).threadRequests.length)).toBe(2);
  await page.evaluate(() => { const requests = (window as any).threadRequests; requests[1].resolve(['Reopened thread reply']); requests[0].resolve(['Old closed thread reply']); });
  await expect(page.locator('.thread-sheet')).toContainText('Reopened thread reply'); await expect(page.locator('.thread-sheet')).not.toContainText('Old closed thread reply');
});

test('account generation replacement clears the old thread root and replies; membership loss also closes it', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => (window as any).replaceAccount());
  await expect(page.locator('.thread-sheet')).toHaveCount(0);
  await page.evaluate(() => (window as any).threadRequests[0].resolve(['Old account reply']));
  await expect(page.locator('.thread-sheet')).toHaveCount(0);
  await page.getByRole('article').filter({ hasText: 'Source message' }).hover();
  await page.getByRole('button', { name: 'Reply in thread', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).threadRequests.length)).toBe(2);
  await page.evaluate(() => { const w = window as any; w.source.updateMyMembership('leave'); w.notify(); for (const request of w.threadRequests.slice(1)) request.resolve(['Lost membership reply']); });
  await expect(page.locator('.thread-sheet')).toHaveCount(0);
});
