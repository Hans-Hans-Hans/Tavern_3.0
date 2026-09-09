import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, query = '') {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const getMatrixClient=()=>window.profileFixture?.client;export const onMatrixUpdate=fn=>{window.profileFixture.listeners.add(fn);return()=>window.profileFixture.listeners.delete(fn)};' }));
  await page.route('**/profile-rules-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/profile-metadata-policy.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/profile-rules-test?' + query);
  await page.waitForFunction(() => !!(window as any).profileFixture);
}

test('profile rules are opt-in and save explicit structured metadata limits with native revision', async ({ page }) => {
  await fixture(page);
  const enabled = page.getByRole('checkbox', { name: 'Enforce server profile rules' });
  await expect(enabled).not.toBeChecked(); await expect(page.getByLabel('Maximum bio length')).toBeDisabled();
  await enabled.check(); await page.getByRole('checkbox', { name: 'Allow profile links' }).uncheck();
  await page.getByRole('checkbox', { name: 'Allow custom profile fields' }).uncheck();
  await page.getByLabel('Maximum bio length').selectOption('160'); await page.getByLabel('Maximum status length').selectOption('0');
  await page.getByRole('button', { name: 'Save profile rules' }).click(); await expect(page.getByRole('status')).toHaveText('Profile rules saved.');
  expect(await page.evaluate(() => (window as any).profileFixture.writes[0][2])).toEqual({ version: 1, enabled: true, allowLinks: false, allowCustomFields: false, maxBioLength: 160, maxStatusLength: 0, 'io.tavern.previous_event': null });
  await enabled.uncheck(); await page.getByRole('button', { name: 'Save profile rules' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).profileFixture.writes.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).profileFixture.writes[1][2]['io.tavern.previous_event'])).toMatch(/^\$state-/);
  await expect(page.getByText(/Older profile events remain readable through Matrix/)).toBeVisible();
});

test('conflicting and rejected policy saves preserve the draft and support explicit reload and retry', async ({ page }) => {
  await fixture(page); await page.getByRole('checkbox', { name: 'Enforce server profile rules' }).check();
  await page.getByLabel('Maximum bio length').selectOption('160');
  await page.evaluate(() => (window as any).profileFixture.server.put('io.tavern.server.profile_policy', { version: 1, enabled: true, allowLinks: false, allowCustomFields: true, maxBioLength: 500, maxStatusLength: 80 }));
  await page.getByRole('button', { name: 'Save profile rules' }).click(); await expect(page.getByRole('alert')).toContainText('Profile rules changed'); await expect(page.getByLabel('Maximum bio length')).toHaveValue('160');
  expect(await page.evaluate(() => (window as any).profileFixture.writes.length)).toBe(0);
  await page.getByRole('button', { name: 'Reload profile rules' }).click(); await expect(page.getByLabel('Maximum bio length')).toHaveValue('500');
  await page.evaluate(() => { (window as any).profileFixture.rejectWrite = true; });
  await page.getByRole('button', { name: 'Save profile rules' }).click(); await expect(page.getByRole('alert')).toHaveText('The server rejected these profile rules.');
  await expect(page.getByLabel('Maximum bio length')).toHaveValue('500');
  await page.evaluate(() => { (window as any).profileFixture.rejectWrite = false; });
  await page.getByRole('button', { name: 'Save profile rules' }).click(); await expect(page.getByRole('status')).toHaveText('Profile rules saved.');
});

test('native power does not grant custom server authority and live permission loss stops writes', async ({ page }) => {
  await fixture(page, 'restricted'); await expect(page.getByRole('button', { name: 'Save profile rules' })).toHaveCount(0);
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).profileFixture; f.beforeRead = () => { f.server.put('m.room.power_levels', { users: {}, state_default: 50 }); f.beforeRead = null; }; });
  await page.getByRole('button', { name: 'Save profile rules' }).click(); await expect(page.getByRole('alert')).toContainText('Permissions or memberships changed');
  expect(await page.evaluate(() => (window as any).profileFixture.writes.length)).toBe(0);
});

test('account replacement during state loading clears the old draft and allows the new owner to retry', async ({ page }) => {
  await fixture(page); await page.getByRole('checkbox', { name: 'Enforce server profile rules' }).check();
  await page.evaluate(() => { const f = (window as any).profileFixture; const gate = new Promise<void>(resolve => { f.release = resolve; }); f.beforeRead = () => { f.beforeRead = null; f.pending = true; return gate; }; });
  await page.getByRole('button', { name: 'Save profile rules' }).click(); await page.waitForFunction(() => (window as any).profileFixture.pending);
  await expect(page.getByRole('button', { name: 'Save profile rules' })).toBeDisabled();
  await page.evaluate(() => { const f = (window as any).profileFixture; f.client = { ...f.client }; for (const listener of f.listeners) listener(); });
  await expect(page.getByRole('checkbox', { name: 'Enforce server profile rules' })).not.toBeChecked(); await expect(page.getByRole('button', { name: 'Save profile rules' })).toBeEnabled();
  await page.evaluate(() => (window as any).profileFixture.release());
  await page.getByRole('button', { name: 'Save profile rules' }).click(); await expect(page.getByRole('status')).toHaveText('Profile rules saved.');
  expect(await page.evaluate(() => (window as any).profileFixture.writes.length)).toBe(1);
});
