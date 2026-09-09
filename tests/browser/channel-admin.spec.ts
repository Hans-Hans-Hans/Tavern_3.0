import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, owner = false) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=fn=>{window.listeners.push(fn);return()=>{};};' }));
  await page.route(url => url.pathname === '/app/notification-settings.tsx', route => route.fulfill({ contentType: 'text/javascript', body: 'export const NotificationSettings=()=>null;' }));
  await page.route('**/channel-admin-test*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/channel-admin.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/channel-admin-test' + (owner ? '?owner' : ''));
}

test('custom moderators see authorized targets and no native power controls', async ({ page }) => {
  await fixture(page);
  await expect(page.getByRole('button', { name: 'Save conversation details' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Channel permissions', exact: true })).toHaveCount(0);
  const members = page.getByRole('combobox', { name: 'Member', exact: true });
  await expect(members.locator('option')).toHaveCount(2);
  await members.selectOption('@member:local');
  await expect(page.getByRole('combobox', { name: 'Action', exact: true }).locator('option')).toHaveText(['Choose an action', 'Remove from conversation', 'Ban from conversation']);
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('kick');
  await page.getByRole('button', { name: 'Review selected action…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Confirm remove from conversation', exact: true })).toBeDisabled();
  await dialog.getByLabel('Type the full Matrix user ID to confirm').fill('@member:local');
  await dialog.getByRole('button', { name: 'Confirm remove from conversation', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).writes)).toEqual([['kick', '!room:local', '@member:local', '']]);
});

test('a native member power change requires target confirmation and aborts when authority changes during the check', async ({ page }) => {
  await fixture(page, true);
  await page.getByRole('combobox', { name: 'Member', exact: true }).selectOption('@member:local');
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('moderator');
  await page.getByRole('button', { name: 'Review selected action…' }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog.getByText(/native power from 0 to 50/)).toBeVisible();
  await dialog.getByLabel('Type the full Matrix user ID to confirm').fill('@member:local');
  await page.evaluate(() => { const w = window as any; w.beforeRead = () => { w.roomPower.users['@owner:local'] = 0; w.beforeRead = null; }; });
  await dialog.getByRole('button', { name: 'Confirm set native power to 50', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Permissions or memberships changed while syncing');
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
});

test('native channel permission changes require room confirmation and preserve member powers', async ({ page }) => {
  await fixture(page, true);
  await page.getByRole('combobox', { name: 'Invite people', exact: true }).selectOption('50');
  await page.getByRole('button', { name: 'Review permission changes…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Confirm channel permissions', exact: true })).toBeDisabled();
  await dialog.getByLabel('Type the room ID to confirm').fill('!room:local');
  await dialog.getByRole('button', { name: 'Confirm channel permissions', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Channel permissions saved.');
  const writes = await page.evaluate(() => (window as any).writes);
  expect(writes).toHaveLength(1); expect(writes[0][1]).toBe('m.room.power_levels');
  expect(writes[0][2].invite).toBe(50); expect(writes[0][2].users).toEqual({ '@owner:local': 100, '@moderator:local': 50 });
});
