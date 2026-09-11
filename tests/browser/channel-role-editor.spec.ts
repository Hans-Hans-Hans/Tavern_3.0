import { expect, test, type Page } from '@playwright/test';
async function fixture(page: Page, extra = '') {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.roleEditorFixture?.client;export const onMatrixUpdate=fn=>{window.roleEditorFixture.listeners.add(fn);return()=>window.roleEditorFixture.listeners.delete(fn)};' }));
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const accountArtworkOwner=()=>window.roleEditorFixture?.account;' }));
  await page.route(url => url.pathname === '/lib/community.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const serverChannelIds=()=>["!voice:test"];export const readServerLayout=()=>window.roleEditorFixture.layout;' }));
  await page.route('**/channel-role-editor-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/server-role-editor.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/channel-role-editor-test?mode=channel&marked' + extra);
  await expect(page.getByRole('heading', { name: 'Channel role permissions', exact: true })).toBeVisible();
}
async function change(page: Page) {
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('helper');
  await page.getByRole('combobox', { name: 'Join calls and conferences', exact: true }).selectOption('-1');
}

test('scoped channel editor saves the selected role override without editing other channels, roles or assignments', async ({ page }) => {
  await fixture(page);
  await expect(page.getByRole('combobox', { name: 'Channel', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add role', exact: true })).toHaveCount(0);
  await expect(page.getByText('Allow only a chosen role to join voice', { exact: true })).toBeVisible();
  await expect(page.getByText(/Keep the Member override here Inherited/)).toBeVisible();
  await expect(page.getByText('Assign member roles', { exact: true })).toHaveCount(0);
  const before = await page.evaluate(() => (window as any).roleEditorFixture.policy);
  await change(page); await page.getByRole('button', { name: 'Save channel role permissions' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).roleEditorFixture.changed)).toBe(1);
  const saved = await page.evaluate(() => (window as any).roleEditorFixture.writes[0]);
  expect(saved.id).toBe('!server:test'); expect(saved.value.overrides['!voice:test'].roles.helper.join_calls).toBe(-1);
  expect(saved.value.roles).toEqual(before.roles); expect(saved.value.members).toEqual(before.members); expect(saved.value.categoryOverrides).toEqual(before.categoryOverrides);
  await expect(page.getByRole('button', { name: 'Save channel role permissions' })).toBeDisabled();
});

test('native membership rejection and concurrent roles retain the scoped draft for review', async ({ page }) => {
  await fixture(page); await change(page);
  await page.evaluate(() => { (window as any).roleEditorFixture.nativeChannelMembership = 'leave'; });
  await page.getByRole('button', { name: 'Save channel role permissions' }).click();
  await expect(page.getByRole('alert')).toContainText('joined child');
  await expect(page.getByRole('combobox', { name: 'Join calls and conferences', exact: true })).toHaveValue('-1');
  expect(await page.evaluate(() => (window as any).roleEditorFixture.writes.length)).toBe(0);
  await page.evaluate(() => { const f = (window as any).roleEditorFixture; f.nativeChannelMembership = 'join'; f.policy = structuredClone(f.policy); f.policy.members['@new:test'] = ['helper']; f.revision++; });
  await page.getByRole('button', { name: 'Save channel role permissions' }).click();
  await expect(page.getByRole('alert')).toContainText('changed elsewhere');
  expect(await page.evaluate(() => (window as any).roleEditorFixture.writes.length)).toBe(0);
});

test('switching channels during native reads retires old save and creates a clean scoped view', async ({ page }) => {
  await fixture(page); await change(page); await page.evaluate(() => { (window as any).roleEditorFixture.holdRead = true; });
  await page.getByRole('button', { name: 'Save channel role permissions' }).click();
  await page.waitForFunction(() => !!(window as any).roleEditorFixture.releaseRead);
  await page.evaluate(() => { const f = (window as any).roleEditorFixture; f.channel = '!second:test'; f.redraw(); });
  await expect(page.getByText('Second voice', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).roleEditorFixture.releaseRead());
  await expect(page.getByRole('combobox', { name: 'Role', exact: true })).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).roleEditorFixture.writes.length)).toBe(0);
});

test('retired account and detached canonical parent do not leave actionable old controls', async ({ page }) => {
  await fixture(page); await change(page);
  await page.evaluate(() => { const f = (window as any).roleEditorFixture; f.parentLink = false; f.notify(); });
  await expect(page.getByRole('button', { name: 'Save channel role permissions' })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('unavailable');
  await page.evaluate(() => { const f = (window as any).roleEditorFixture; f.account++; f.parentLink = true; f.notify(); });
  await expect(page.getByRole('heading', { name: 'Channel role permissions' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).roleEditorFixture.writes.length)).toBe(0);
});

test('channel permissions fit narrow settings and retain inherited/allow/deny controls', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 650 }); await fixture(page); await change(page);
  await expect(page.getByRole('combobox', { name: 'Publish camera video', exact: true })).toBeVisible();
  expect(await page.getByRole('combobox', { name: 'Join calls and conferences', exact: true }).locator('option').allTextContents()).toEqual(['Inherited', 'Allow', 'Deny']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
