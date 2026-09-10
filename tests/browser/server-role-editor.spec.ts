import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, query = '') {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.roleEditorFixture?.client;export const onMatrixUpdate=fn=>{window.roleEditorFixture.listeners.add(fn);return()=>window.roleEditorFixture.listeners.delete(fn)};' }));
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const accountArtworkOwner=()=>window.roleEditorFixture?.account;' }));
  await page.route(url => url.pathname === '/lib/community.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const serverChannelIds=()=>["!voice:test"];export const readServerLayout=()=>window.roleEditorFixture.layout;' }));
  await page.route('**/server-role-editor-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/server-role-editor.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/server-role-editor-test' + query);
}

test('create a recognizable role, choose grouped permissions and assign a member in one native save', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Add role', exact: true }).click();
  await page.getByRole('textbox', { name: 'Role name', exact: true }).fill('Night owls');
  await page.getByRole('button', { name: 'Use role icon ☕', exact: true }).click();
  await page.getByRole('button', { name: 'Use role color #b48cf2', exact: true }).click();
  await expect(page.getByLabel('Role preview')).toContainText('☕ Night owls');
  await page.getByRole('tab', { name: 'Permissions', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find a permission' }).fill('Pin');
  await page.getByRole('checkbox', { name: 'Pin messages', exact: true }).check();
  await page.getByText('Assign member roles', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Member', exact: true }).selectOption('@member:test');
  await page.getByRole('checkbox', { name: '☕ Night owls', exact: true }).check();
  await page.getByRole('button', { name: 'Save roles and permissions' }).click();
  await expect(page.getByRole('status')).toContainText('No unsaved changes');
  const saved = await page.evaluate(() => (window as any).roleEditorFixture.writes[0].value);
  const role = saved.roles.find((item: any) => item.name === 'Night owls');
  expect(role).toMatchObject({ icon: '☕', color: '#b48cf2', permissions: ['pin_messages'], mentionable: false });
  expect(saved.members['@member:test'].sort()).toEqual(['helper', role.id].sort());
});

test('conference migration cannot discard a local draft and preserves saved roles before showing new controls', async ({ page }) => {
  await fixture(page); await page.getByRole('textbox', { name: 'Role name' }).fill('Everyone here');
  await page.getByRole('tab', { name: 'Permissions', exact: true }).click();
  const enable = page.getByRole('button', { name: 'Enable conference publication permissions' });
  await expect(enable).toBeDisabled(); await expect(page.getByRole('checkbox', { name: 'Publish camera video' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reload saved roles' }).click(); await enable.click();
  await expect(page.getByRole('checkbox', { name: 'Publish camera video' })).toBeChecked();
  const saved = await page.evaluate(() => (window as any).roleEditorFixture.writes[0].value);
  expect(saved.callPublicationVersion).toBe(1); expect(saved['io.tavern.previous_event']).toBe('$roles-0');
  expect(saved.roles[0].name).toBe('Member'); expect(saved.members['@member:test']).toEqual(['helper']);
});

test('duplicate roles retain appearance and permissions but never copy assignments or mentionability', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Edit Helper (helper)' }).click();
  await page.getByRole('button', { name: 'Duplicate role' }).click();
  await expect(page.getByRole('textbox', { name: 'Role name' })).toHaveValue('Helper copy');
  await expect(page.getByRole('checkbox', { name: 'Allow members to mention this role' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Save roles and permissions' }).click();
  const saved = await page.evaluate(() => (window as any).roleEditorFixture.policy);
  expect(saved.members['@member:test']).toEqual(['helper']);
  expect(saved.roles.find((item: any) => item.name === 'Helper copy')).toMatchObject({ permissions: ['pin_messages'], icon: '🌱', color: '#52b788' });
});

test('role hierarchy remains read only for peers and unpublished grants cannot be assigned', async ({ page }) => {
  await fixture(page, '?actor=mod'); await page.getByRole('button', { name: 'Edit Moderator (mod)' }).click();
  await expect(page.getByRole('textbox', { name: 'Role name' })).toBeDisabled();
  await page.getByRole('button', { name: 'Add role', exact: true }).click();
  await page.getByRole('tab', { name: 'Permissions', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Manage server details', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Pin messages', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Enable conference publication permissions' })).toHaveCount(0);
  await page.getByText('Assign member roles', { exact: true }).click();
  expect(await page.getByRole('combobox', { name: 'Member', exact: true }).locator('option').allTextContents()).not.toContain('Native peer (@peer:test)');
});

test('a concurrent member assignment rejects the stale role save and retains the draft', async ({ page }) => {
  await fixture(page, '?marked'); await page.getByRole('textbox', { name: 'Role name' }).fill('Draft name');
  await page.evaluate(() => { const f = (window as any).roleEditorFixture; f.policy = structuredClone(f.policy); f.policy.members['@new:test'] = ['helper']; f.revision++; });
  await page.getByRole('button', { name: 'Save roles and permissions' }).click();
  await expect(page.getByRole('alert')).toContainText('changed elsewhere');
  await expect(page.getByRole('textbox', { name: 'Role name' })).toHaveValue('Draft name');
  expect(await page.evaluate(() => (window as any).roleEditorFixture.writes.length)).toBe(0);
});

test('account replacement during an acknowledged role save hides the editor and suppresses stale completion', async ({ page }) => {
  await fixture(page); await page.getByRole('textbox', { name: 'Role name' }).fill('Pending name');
  await page.evaluate(() => { (window as any).roleEditorFixture.holdWrite = true; });
  await page.getByRole('button', { name: 'Save roles and permissions' }).click();
  await page.waitForFunction(() => typeof (window as any).roleEditorFixture.releaseWrite === 'function');
  await page.evaluate(() => { const f = (window as any).roleEditorFixture; f.account++; f.notify(); f.releaseWrite(); });
  await expect(page.getByRole('heading', { name: 'Server roles and permissions' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).roleEditorFixture.changed)).toBe(0);
  await expect(page.getByText('Server roles saved', { exact: true })).toHaveCount(0);
});

test('member assignment search keeps selections and closes on account change during native acknowledgement', async ({ page }) => {
  await fixture(page, '?mode=member'); await page.getByRole('button', { name: 'Edit Morgan' }).click();
  await page.getByRole('searchbox', { name: 'Find a role' }).fill('Moderator');
  await page.getByRole('checkbox', { name: '🛡️ Moderator', exact: true }).check();
  await expect(page.getByLabel('Selected member roles')).toContainText('Helper');
  await page.evaluate(() => { (window as any).roleEditorFixture.holdWrite = true; });
  await page.getByRole('button', { name: 'Save member roles' }).click();
  await page.waitForFunction(() => typeof (window as any).roleEditorFixture.releaseWrite === 'function');
  await page.evaluate(() => { const f = (window as any).roleEditorFixture; f.account++; f.notify(); f.releaseWrite(); });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).roleEditorFixture.changed)).toBe(0);
  await expect(page.getByText('Member roles saved', { exact: true })).toHaveCount(0);
});

test('category save never presents completion after its owning server membership is lost', async ({ page }) => {
  await fixture(page, '?mode=category&marked'); await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('everyone');
  await page.getByRole('combobox', { name: 'Publish camera video', exact: true }).selectOption('-1');
  await page.evaluate(() => { (window as any).roleEditorFixture.holdWrite = true; });
  await page.getByRole('button', { name: 'Save category permissions' }).click();
  await page.waitForFunction(() => typeof (window as any).roleEditorFixture.releaseWrite === 'function');
  await page.evaluate(() => { const f = (window as any).roleEditorFixture; f.membership = 'leave'; f.notify(); f.releaseWrite(); });
  await expect(page.getByRole('heading', { name: 'Category permissions' })).toHaveCount(0);
  await expect(page.getByText('Category permissions saved', { exact: true })).toHaveCount(0);
});

for (const width of [320, 390, 650, 1280]) test('role controls fit a ' + width + 'px viewport without clipping overflow', async ({ page }) => {
  await page.setViewportSize({ width, height: 600 }); await fixture(page, '?marked');
  await page.getByRole('tab', { name: 'Permissions', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Publish camera video', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('tab', { name: 'Appearance', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Permissions', exact: true })).toBeFocused();
});
