import { test, expect } from '@playwright/test';
test('server audit uses filtered native history and keeps paging through filtered empty results', async ({ page }) => {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=()=>()=>{};' }));
  await page.route('**/server-audit-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/server-audit.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/server-audit-test'); await expect(page.getByText('Updated server roles and permissions', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Action category' }).selectOption('moderation'); await page.getByRole('button', { name: 'Filter this page' }).click(); await expect(page.getByText('No matching audit events on this page.')).toBeVisible();
  await page.getByRole('button', { name: 'Older audit page' }).click(); await expect(page.getByText('Banned member', { exact: true })).toBeVisible(); await expect(page.getByText('Repeated spam')).toBeVisible();
  const calls = await page.evaluate(() => (window as any).pages); expect(calls[1].from).toBe('opaque-older'); expect(calls[1].limit).toBe(50); expect(calls[0].filter.room.timeline.types).toContain('io.tavern.roles'); expect(calls[0].filter.room.timeline.types).not.toContain('m.room.encrypted');
  await page.getByRole('button', { name: 'Newer audit page' }).click(); await expect(page.getByText('No matching audit events on this page.')).toBeVisible();
});
