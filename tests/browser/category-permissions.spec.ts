import { test, expect } from '@playwright/test';
test('category permission editor saves real overrides and preserves unrelated concurrent changes', async ({ page }) => {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=()=>()=>{};' }));
  await page.route('**/category-permissions-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/category-permissions.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/category-permissions-test'); await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('everyone');
  await page.getByRole('combobox', { name: 'Send messages and encrypted content', exact: true }).selectOption('-1');
  await page.evaluate(() => { const w = window as any; w.policy.categoryOverrides.other = { roles: { everyone: { invite: -1 } }, users: {} }; w.policy.categoryOverrides.chat = { roles: {}, users: { '@bob:local': { add_reactions: -1 } } }; });
  await page.getByRole('button', { name: 'Save category permissions', exact: true }).click(); await page.waitForFunction(() => (window as any).saves === 1);
  const categories = await page.evaluate(() => (window as any).policy.categoryOverrides); expect(categories.chat.roles.everyone.send_messages).toBe(-1); expect(categories.chat.users['@bob:local'].add_reactions).toBe(-1); expect(categories.other.roles.everyone.invite).toBe(-1);
  await page.getByRole('button', { name: 'Reset this target to inherited' }).click(); await page.getByRole('button', { name: 'Save category permissions', exact: true }).click(); await page.waitForFunction(() => (window as any).saves === 2);
  expect(await page.evaluate(() => (window as any).policy.categoryOverrides.chat.roles.everyone)).toBeUndefined(); expect(await page.evaluate(() => (window as any).policy.categoryOverrides.chat.users['@bob:local'].add_reactions)).toBe(-1);
});
