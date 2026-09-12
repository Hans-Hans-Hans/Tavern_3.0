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

test('admin raises attachment size with a preset and the saved limit survives reload', async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width: 390, height: 844 });
  let storage = { maxUploadBytes: 10485760, maxUploadAllowedBytes: 512 * 1048576, homeserverMaxUploadBytes: 512 * 1048576, userQuotaBytes: 1073741824, globalQuotaBytes: 10737418240, usageInitialized: true, globalUsedBytes: 0, uncertainReservations: 0, reconciledAt: 1700000000000 };
  const writes: any[] = [];
  await page.route('**/api/admin/storage', route => {
    if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); writes.push(body); storage = { ...storage, ...body }; }
    return route.fulfill({ json: storage });
  });
  await page.goto('/admin-integrations-test?storage');
  await page.getByRole('button', { name: '100 MiB', exact: true }).click();
  await expect(page.getByLabel('Maximum file size (MiB)')).toHaveValue('100');
  await page.getByRole('button', { name: 'Save storage policy', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ maxUploadBytes: 100 * 1048576, userQuotaBytes: 1073741824, globalQuotaBytes: 10737418240 });
  await page.reload();
  await expect(page.getByLabel('Maximum file size (MiB)')).toHaveValue('100');
  await expect(page.getByLabel('Maximum file size (MiB)')).toHaveAttribute('max', '512');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'work/upload-admin-mobile.png' });
});

test('storage editor explains a lower native ceiling and retains a rejected draft', async ({ page }) => {
  await fixture(page);
  const storage = { maxUploadBytes: 10485760, maxUploadAllowedBytes: 512 * 1048576, homeserverMaxUploadBytes: 10485760, userQuotaBytes: 1073741824, globalQuotaBytes: 10737418240, usageInitialized: true, globalUsedBytes: 0, uncertainReservations: 0, reconciledAt: null };
  await page.route('**/api/admin/storage', route => route.request().method() === 'PUT' ? route.fulfill({ status: 400, json: { error: 'File size must fit the user quota.' } }) : route.fulfill({ json: storage }));
  await page.goto('/admin-integrations-test?storage');
  await page.getByRole('button', { name: '250 MiB', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('exceeds the running homeserver limit');
  await page.getByRole('button', { name: 'Save storage policy', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('File size must fit the user quota');
  await expect(page.getByLabel('Maximum file size (MiB)')).toHaveValue('250');
});

test('webhook editing uploads an optimized avatar and preserves its token, destination and creator', async ({ page }) => {
  const current = { ...inventory, hooks: [{ ...inventory.hooks[0], name: 'Build alerts', avatarUrl: '', enabled: true, createdBy: '@owner:test', createdAt: 1700000000000 }] };
  await fixture(page, current); let submitted: any, uploadedType = '';
  await page.route('**/api/matrix/_matrix/media/v3/upload', route => { uploadedType = route.request().headers()['content-type']; expect(route.request().headers().authorization).toBe('Bearer cookie-session:FIXTURE'); return route.fulfill({ json: { content_uri: 'mxc://test/icon_123' } }); });
  await page.route('**/api/matrix/_matrix/client/v1/media/thumbnail/**', route => route.fulfill({ status: 404 }));
  await page.route('**/api/admin/integrations/hooks/builds', route => { submitted = route.request().postDataJSON(); expect(route.request().method()).toBe('PUT'); Object.assign(current.hooks[0], { name: submitted.name, enabled: submitted.enabled, avatarUrl: submitted.avatarUrl }); return route.fulfill({ json: { ok: true, revision: 'revision-two' } }); });
  await page.goto('/admin-integrations-test'); await expect(page.getByText('@owner:test', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit webhook', exact: true }).click();
  await expect(page.getByLabel('Encrypted destination room ID')).toHaveAttribute('readonly', '');
  await page.getByLabel('Webhook name', { exact: true }).fill('Release alerts'); await page.getByLabel('Webhook enabled', { exact: true }).uncheck();
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4; const context = canvas.getContext('2d')!; context.fillStyle = '#d9480f'; context.fillRect(0, 0, 4, 4); return canvas.toDataURL('image/png').split(',')[1]; });
  await page.getByLabel('Choose webhook avatar', { exact: true }).setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.getByRole('button', { name: 'Remove webhook avatar' })).toBeVisible();
  await page.getByLabel('Type builds to confirm').fill('builds'); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => submitted?.avatarUrl).toBe('mxc://test/icon_123'); expect(uploadedType).toBe('image/webp');
  expect(submitted).toEqual({ roomId: '!room:test', name: 'Release alerts', avatarUrl: 'mxc://test/icon_123', enabled: false, allowedUsers: ['@bot:test', '@alice:test'], confirmation: 'builds', revision: 'revision-one' });
  await expect(page.getByRole('row').filter({ hasText: 'Release alerts' })).toContainText('Disabled'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('@owner:test', { exact: true })).toBeVisible();
});

test('channel delegates use scoped routes and never see global device approval controls', async ({ page }) => {
  await fixture(page); let submitted: any;
  await page.route('**/api/integrations?roomId=*', route => route.fulfill({ json: { ...inventory, pins: [] } }));
  await page.route('**/api/integrations/hooks/builds/rotate', route => { submitted = route.request().postDataJSON(); return route.fulfill({ json: { revision: 'revision-two', secret: 'delegated-once-only' } }); });
  await page.goto('/admin-integrations-test?room=' + encodeURIComponent('!room:test'));
  await expect(page.getByRole('heading', { name: 'Channel webhooks', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve verified device' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create webhook', exact: true }).click();
  await expect(page.getByLabel('Encrypted destination room ID')).toHaveValue('!room:test'); await expect(page.getByLabel('Encrypted destination room ID')).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Rotate secret', exact: true }).click(); await page.getByLabel('Type builds to confirm').fill('builds'); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Webhook signing secret', exact: true })).toHaveValue('delegated-once-only');
  expect(submitted).toEqual({ confirmation: 'builds', revision: 'revision-one', roomId: '!room:test' });
});
