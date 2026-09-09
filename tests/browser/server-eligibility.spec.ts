import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, query = '') {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=fn=>{window.listeners.add(fn);return()=>window.listeners.delete(fn)};' }));
  await page.route('**/server-eligibility-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/server-eligibility.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/server-eligibility-test?' + query);
}

test('server verification saves explicit email and native age choices, and supports disabling requirements', async ({ page }) => {
  await fixture(page);
  const email = page.getByRole('checkbox', { name: 'Require a verified email address' });
  await expect(email).not.toBeChecked();
  await email.check(); await page.getByLabel('Minimum account age').selectOption('86400');
  await page.getByRole('button', { name: 'Save verification settings' }).click();
  await expect(page.getByRole('status')).toHaveText('Verification settings saved.');
  expect(await page.evaluate(() => (window as any).writes[0])).toEqual(['!server:local', 'io.tavern.server.eligibility', { version: 1, requireVerifiedEmail: true, minimumAccountAgeSeconds: 86400, 'io.tavern.previous_event': null }, '']);
  await email.uncheck(); await page.getByLabel('Minimum account age').selectOption('0');
  await page.getByRole('button', { name: 'Save verification settings' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).writes.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).writes[1][2])).toMatchObject({ requireVerifiedEmail: false, minimumAccountAgeSeconds: 0, 'io.tavern.previous_event': '$state-1-io.tavern.server.eligibility' });
});

test('verification retains rejected drafts and reloads a changed native revision before retrying', async ({ page }) => {
  await fixture(page);
  await page.getByRole('checkbox', { name: 'Require a verified email address' }).check();
  await page.evaluate(() => { (window as any).server.put('io.tavern.server.eligibility', { version: 1, requireVerifiedEmail: false, minimumAccountAgeSeconds: 300 }); });
  await page.getByRole('button', { name: 'Save verification settings' }).click();
  await expect(page.getByRole('alert')).toContainText('settings changed');
  await expect(page.getByRole('checkbox', { name: 'Require a verified email address' })).toBeChecked();
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
  await page.getByRole('button', { name: 'Reload verification settings' }).click();
  await expect(page.getByLabel('Minimum account age')).toHaveValue('300');
  await page.evaluate(() => { (window as any).rejectWrite = true; });
  await page.getByRole('button', { name: 'Save verification settings' }).click();
  await expect(page.getByRole('alert')).toHaveText('The server rejected these settings.');
  await expect(page.getByLabel('Minimum account age')).toHaveValue('300');
});

test('native power alone cannot expose verification editing, and permission changes cancel pending saves', async ({ page }) => {
  await fixture(page, 'restricted');
  await expect(page.getByRole('button', { name: 'Save verification settings' })).toHaveCount(0);
  await fixture(page);
  await page.evaluate(() => { const w = window as any; w.beforeRead = () => { w.server.power.users[w.actor] = 0; w.beforeRead = null; }; });
  await page.getByRole('button', { name: 'Save verification settings' }).click();
  await expect(page.getByRole('alert')).toContainText('Permissions or memberships changed');
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
});

test('account replacement during a save resets the editor and leaves the new owner able to retry', async ({ page }) => {
  await fixture(page);
  await page.getByRole('checkbox', { name: 'Require a verified email address' }).check();
  await page.evaluate(() => { const w = window as any; const gate = new Promise<void>(resolve => { w.releaseOldRead = resolve; }); w.beforeRead = () => { w.beforeRead = null; w.oldReadPending = true; return gate; }; });
  await page.getByRole('button', { name: 'Save verification settings' }).click(); await page.waitForFunction(() => (window as any).oldReadPending);
  await expect(page.getByRole('button', { name: 'Save verification settings' })).toBeDisabled();
  await page.evaluate(() => { const w = window as any; w.server.put('io.tavern.server.eligibility', { version: 1, requireVerifiedEmail: false, minimumAccountAgeSeconds: 300, 'io.tavern.previous_event': null }); w.fixtureClient = { ...w.fixtureClient }; for (const listener of w.listeners) listener(); });
  await expect(page.getByRole('button', { name: 'Save verification settings' })).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: 'Require a verified email address' })).not.toBeChecked(); await expect(page.getByLabel('Minimum account age')).toHaveValue('300');
  await page.evaluate(() => (window as any).releaseOldRead()); await page.getByRole('button', { name: 'Save verification settings' }).click();
  await expect(page.getByRole('status')).toHaveText('Verification settings saved.');
  expect(await page.evaluate(() => (window as any).writes)).toHaveLength(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
