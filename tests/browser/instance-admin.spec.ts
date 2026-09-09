import { test, expect } from '@playwright/test';
const selected = '/api/branding/assets/' + 'a'.repeat(64) + '.png', unused = '/api/branding/assets/' + 'b'.repeat(64) + '.png';
async function fixture(page: any) {
  await page.route('**/instance-admin-test*', (route: any) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/tests/browser/fixtures/instance-admin.tsx');</script></body></html>` }));
}
test('branding upload binds the current device and stale saves preserve the uploaded draft', async ({ page }) => {
  await fixture(page); let uploaded: any, saved: any;
  await page.route('**/api/admin/branding', route => { if (route.request().method() === 'PUT') { saved = route.request().postDataJSON(); return route.fulfill({ status: 409, json: { error: 'Branding changed. Reload it before saving.', errcode: 'CONFIG_CHANGED' } }); } return route.fulfill({ json: { name: 'Tavern', revision: 'old-revision', unusedAssets: [] } }); });
  await page.route('**/api/admin/branding/assets/icon', route => { uploaded = route.request(); return route.fulfill({ json: { url: selected } }); });
  await page.goto('/instance-admin-test'); await page.getByLabel('Instance name', { exact: true }).fill('Community draft');
  await page.getByLabel('Upload icon').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('decoded-by-server') });
  await expect(page.getByRole('status')).toContainText('Save branding to publish');
  expect(uploaded.headers()['x-tavern-device']).toBe('CURRENT-DEVICE');
  await page.getByRole('button', { name: 'Save branding', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Branding changed');
  expect(saved.icon).toBe(selected); expect(saved.revision).toBe('old-revision');
  await expect(page.getByLabel('Instance name', { exact: true })).toHaveValue('Community draft');
});
test('branding cleanup excludes current draft images and preserves unsaved text', async ({ page }) => {
  await fixture(page); let removed: any;
  await page.route('**/api/admin/branding', route => route.fulfill({ json: { name: 'Tavern', revision: 'revision', icon: selected, unusedAssets: [selected, unused] } }));
  await page.route('**/api/admin/branding/cleanup', route => { removed = route.request().postDataJSON(); return route.fulfill({ json: { name: 'Tavern', revision: 'revision', icon: selected, unusedAssets: [] } }); });
  await page.goto('/instance-admin-test'); await page.getByLabel('Instance name', { exact: true }).fill('Unsaved name');
  await page.getByRole('button', { name: 'Remove unused branding images (1)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove images', exact: true })).toBeDisabled();
  await page.getByLabel('Type DELETE UNUSED to confirm').fill('DELETE UNUSED'); await page.getByRole('button', { name: 'Remove images', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(removed.assets).toEqual([unused]);
  await expect(page.getByLabel('Instance name', { exact: true })).toHaveValue('Unsaved name');
});
test('mandatory enrollment reveals recovery codes before continuing and keeps them out of browser storage', async ({ page }) => {
  await fixture(page); let completed: any;
  await page.route('**/api/account/mfa/totp/start', route => route.fulfill({ json: { challengeId: 'setup', secret: 'MFA-SETUP-SECRET', uri: 'otpauth://totp/Tavern?secret=TEST' } }));
  await page.route('**/api/account/mfa/totp/complete', route => { completed = route.request().postDataJSON(); return route.fulfill({ json: { recoveryCodes: ['RECOVERY-ONE', 'RECOVERY-TWO'] } }); });
  await page.goto('/instance-admin-test?enrollment'); await page.getByLabel('Current password', { exact: true }).fill('Current password!'); await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
  await expect(page.getByText('MFA-SETUP-SECRET', { exact: true })).toBeVisible(); await page.getByLabel('Authenticator code', { exact: true }).fill('123456'); await page.getByRole('button', { name: 'Enable two-step verification', exact: true }).click();
  await expect(page.getByText('RECOVERY-ONE', { exact: true })).toBeVisible(); expect(completed).toEqual({ challengeId: 'setup', code: '123456' });
  expect(await page.locator('body').getAttribute('data-completed')).toBeNull();
  expect(await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join(' '))).not.toContain('RECOVERY-');
  await page.getByRole('button', { name: /I saved my codes/ }).click(); await expect(page.locator('body')).toHaveAttribute('data-completed', 'yes');
});
test('security policy retains current password after sending email MFA and submits revision', async ({ page }) => {
  await fixture(page); let submitted: any;
  await page.route('**/api/admin/security-policy', route => { if (route.request().method() === 'PUT') { submitted = route.request().postDataJSON(); return route.fulfill({ status: 409, json: { error: 'Security policy changed. Reload before saving.' } }); } return route.fulfill({ json: { revision: 'policy-revision', minimumPasswordLength: 12, sessionHours: 12, persistentDays: 30, loginPerIpPerMinute: 12, loginPerAccountPerFiveMinutes: 10, mfaRequirement: 'off', registrationMode: 'admin', deployment: { allowedOrigin: 'https://tavern.test', trustedProxyCidrs: '172.23.0.0/24', uploadValidation: 'Encrypted content is opaque.' } } }); });
  await page.route('**/api/account/security', route => route.fulfill({ json: { emailMfaEnabled: true, totpEnabled: false } }));
  await page.route('**/api/account/security/email-code', route => route.fulfill({ json: { challengeId: 'email-challenge' } }));
  await page.goto('/instance-admin-test?security'); await page.getByLabel('Current administrator password', { exact: true }).fill('Current password!');
  await page.getByRole('button', { name: 'Send administrator verification code' }).click(); await expect(page.getByLabel('Current administrator password', { exact: true })).toHaveValue('Current password!');
  await page.getByLabel('Verification code', { exact: true }).fill('123456'); await page.getByRole('combobox', { name: 'Require two-step verification', exact: true }).selectOption('everyone'); await page.getByRole('button', { name: 'Save security policy', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Security policy changed'); expect(submitted.revision).toBe('policy-revision'); expect(submitted.password).toBe('Current password!'); expect(submitted.challengeId).toBe('email-challenge'); expect(submitted.settings.mfaRequirement).toBe('everyone');
});
