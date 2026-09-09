import { test, expect } from '@playwright/test';
const inventory = { enabled: true, configured: true, applied: false, ready: false, revision: 'revision-one', hooks: [{ id: 'builds', roomId: '!room:test', allowedUsers: ['@bot:test', '@alice:test'], url: 'https://tavern.test/hooks/builds' }], pins: [] };
async function fixture(page: any, value: any = inventory) {
  await page.route('**/api/admin/integrations', (route: any) => route.fulfill({ json: value }));
  await page.route('**/admin-integrations-test*', (route: any) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/tests/browser/fixtures/admin-integrations.tsx');</script></body></html>` }));
}

test('secret rotation requires confirmation and preserves its only secret when refresh fails', async ({ page }) => {
  await fixture(page); let submitted: any;
  await page.route('**/api/admin/integrations/hooks/builds/rotate', async route => { submitted = route.request().postDataJSON(); await page.unroute('**/api/admin/integrations'); await page.route('**/api/admin/integrations', route => route.fulfill({ status: 502, json: { error: 'Inventory unavailable' } })); await route.fulfill({ json: { secret: 'one-time-signing-secret', revision: 'revision-two' } }); });
  await page.goto('/admin-integrations-test');
  await expect(page.getByText('Pending or unavailable', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rotate secret', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await page.getByLabel('Type builds to confirm').fill('builds');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Webhook signing secret', exact: true })).toHaveValue('one-time-signing-secret');
  expect(submitted).toEqual({ confirmation: 'builds', revision: 'revision-one' });
  expect(await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join(' '))).not.toContain('one-time-signing-secret');
  expect(page.url()).not.toContain('one-time-signing-secret');
  await page.getByRole('button', { name: 'I saved the secret' }).click();
  await expect(page.getByRole('textbox', { name: 'Webhook signing secret', exact: true })).toHaveCount(0);
});

test('device approval requires separate verification and sends the exact fingerprint with revision', async ({ page }) => {
  await fixture(page); let submitted: any;
  await page.route('**/api/admin/integrations/pins', route => { submitted = route.request().postDataJSON(); return route.fulfill({ json: { ok: true, revision: 'revision-two' } }); });
  await page.goto('/admin-integrations-test'); await page.getByRole('button', { name: 'Approve verified device', exact: true }).click();
  await page.getByLabel('Matrix user ID').fill('@alice:test'); await page.getByLabel('Device ID', { exact: true }).fill('PHONE'); await page.getByLabel('Independently verified Ed25519 fingerprint').fill('A'.repeat(43)); await page.getByLabel('Type VERIFIED to confirm').fill('VERIFIED');
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await page.getByLabel('I compared this fingerprint through a trusted separate channel').check();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => submitted).toEqual({ userId: '@alice:test', deviceId: 'PHONE', fingerprint: 'A'.repeat(43), confirmation: 'VERIFIED', revision: 'revision-one' });
});

test('stale revision prevents retries until the operator reloads without losing form entries', async ({ page }) => {
  await fixture(page); let attempts = 0;
  await page.route('**/api/admin/integrations/hooks', route => { attempts++; return route.fulfill({ status: 409, json: { error: 'Configuration changed', errcode: 'CONFIG_CHANGED' } }); });
  await page.goto('/admin-integrations-test'); await page.getByRole('button', { name: 'Create webhook', exact: true }).click();
  await page.getByLabel('Webhook ID', { exact: true }).fill('alerts'); await page.getByLabel('Encrypted destination room ID').fill('!room:test'); await page.getByLabel('Approved Matrix users, one per line').fill('@bot:test\n@alice:test'); await page.getByLabel('Type the destination room ID to confirm').fill('!room:test');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click(); await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Webhook ID', { exact: true })).toHaveValue('alerts'); expect(attempts).toBe(1);
  await page.getByRole('button', { name: 'Reload configuration', exact: true }).click(); await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled();
});

test('unknown storage is never displayed as zero and reconciliation replaces it with measured usage', async ({ page }) => {
  await fixture(page); const storage = { maxUploadBytes: 10485760, userQuotaBytes: 1073741824, globalQuotaBytes: 10737418240, usageInitialized: false, globalUsedBytes: null, uncertainReservations: 2, reconciledAt: null, scope: 'Local original media bytes. Thumbnails and backups are not included.' }; let reconciled = false;
  await page.route('**/api/admin/storage', route => route.fulfill({ json: storage })); await page.route('**/api/admin/storage/reconcile', route => { reconciled = true; return route.fulfill({ json: { ...storage, usageInitialized: true, globalUsedBytes: 2097152, uncertainReservations: 0, reconciledAt: 1700000000000 } }); });
  await page.goto('/admin-integrations-test?storage');
  await expect(page.locator('.admin-metric').filter({ hasText: 'Recorded instance usage' })).toContainText('Unavailable'); await expect(page.getByText(storage.scope)).toBeVisible(); await expect(page.getByText('Some uploads lost their final response.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Reconcile storage usage' }).click(); await expect.poll(() => reconciled).toBe(true); await expect(page.locator('.admin-metric').filter({ hasText: 'Recorded instance usage' })).toContainText('2 MiB');
});
