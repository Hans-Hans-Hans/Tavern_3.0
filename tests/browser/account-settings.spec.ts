import { test, expect } from '@playwright/test';
async function fixture(page: any, security: any) {
  await page.route(url => url.pathname === '/lib/matrix.ts', (r: any) => r.fulfill({ contentType: 'text/javascript', body: "export const getMatrixClient=()=>({getUserId:()=> '@alice:local'});export const clearLocalMatrixSession=()=>{};" }));
  await page.route('**/api/account/security', (r: any) => r.fulfill({ json: security }));
  await page.route('**/api/account/sessions', (r: any) => r.fulfill({ json: { sessions: [] } }));
  await page.route('**/account-component-test', (r: any) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/tests/browser/fixtures/account-settings.tsx');</script></body></html>` }));
}
test('email-only MFA defaults correctly and sending its code preserves entered passwords', async ({ page }) => {
  await fixture(page, { email: 'alice@example.test', emailVerified: true, totpEnabled: false, emailMfaEnabled: true, recoveryCodesRemaining: 4 });
  await page.route('**/api/account/security/email-code', r => r.fulfill({ json: { challengeId: 'email-check' } }));
  await page.goto('/account-component-test'); await expect(page.getByRole('combobox', { name: 'Verification method' })).toHaveValue('email'); await page.getByLabel('Current password').fill('private-test-password'); await page.getByLabel('New password', { exact: true }).fill('replacement-test-password'); await page.getByRole('button', { name: 'Send email code' }).click(); await expect(page.getByLabel('Current password')).toHaveValue('private-test-password'); await expect(page.getByLabel('New password', { exact: true })).toHaveValue('replacement-test-password');
});
test('successful MFA enrollment still displays recovery codes when refreshing security fails', async ({ page }) => {
  await fixture(page, { email: 'alice@example.test', emailVerified: true, totpEnabled: false, emailMfaEnabled: false, recoveryCodesRemaining: 0 });
  await page.route('**/api/account/mfa/totp/start', r => r.fulfill({ json: { challengeId: 'totp-test', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP' } }));
  await page.route('**/api/account/mfa/totp/complete', async r => { await page.unroute('**/api/account/security'); await page.route('**/api/account/security', r => r.fulfill({ status: 502, json: { error: 'Temporary refresh failure' } })); await r.fulfill({ json: { recoveryCodes: ['test-recovery-a', 'test-recovery-b'] } }); });
  await page.goto('/account-component-test'); await page.getByRole('button', { name: 'Set up authenticator' }).click(); let dialog = page.getByRole('dialog'); await dialog.getByLabel('Current password').fill('private-test-password'); await dialog.getByRole('button', { name: 'Confirm', exact: true }).click(); await expect(dialog.getByText('JBSWY3DPEHPK3PXP', { exact: true })).toBeVisible(); await dialog.getByLabel('Verification code').fill('123456'); await dialog.getByRole('button', { name: 'Confirm', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible(); await expect(page.getByText('test-recovery-a', { exact: true })).toBeVisible();
});

test('account owner can retry an administrator-sent email code and refresh verified status', async ({ page }) => {
  const security = { email: 'alice@example.test', emailVerified: false, totpEnabled: false, emailMfaEnabled: false, recoveryCodesRemaining: 0 };
  await fixture(page, security); const submissions: any[] = [];
  await page.route('**/api/account/email/pending/complete', route => {
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) return route.fulfill({ status: 503, json: { error: 'Temporary verification failure' } });
    security.emailVerified = true; return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/account-component-test');
  await page.getByRole('button', { name: 'Enter administrator-sent email code' }).click();
  await page.getByLabel('Administrator-sent email code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify associated email', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Temporary verification failure');
  await expect(page.getByLabel('Administrator-sent email code', { exact: true })).toHaveValue('123456');
  await page.getByRole('button', { name: 'Verify associated email', exact: true }).click();
  await expect(page.getByText('alice@example.test · Verified')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter administrator-sent email code' })).toHaveCount(0);
  expect(submissions).toEqual([{ code: '123456' }, { code: '123456' }]);
});

for (const phase of ['complete', 'pending', 'native_confirmed']) {
  test(`account deactivation preserves the ${phase} outcome when signing out`, async ({ page }) => {
    await fixture(page, { totpEnabled: false, emailMfaEnabled: false });
    const message = phase === 'complete' ? 'Your account has been deactivated. Historical messages and uploaded files have not been deleted.' : phase === 'pending' ? 'Your account deactivation is awaiting confirmation. Reference: operation-123.' : 'Your homeserver account is deactivated. Tavern is finishing local personal-data cleanup.';
    let submitted: any;
    await page.route('**/api/account/deactivate', route => { submitted = route.request().postDataJSON(); return route.fulfill({ status: phase === 'complete' ? 200 : 202, json: { ok: phase === 'complete', deactivation: { id: 'operation-123', phase }, message } }); });
    await page.goto('/account-component-test');
    await page.evaluate(() => { (window as any).signedOut = ''; window.addEventListener('tavern:signout', event => { (window as any).signedOut = (event as CustomEvent).detail; }); });
    await page.getByRole('button', { name: 'Delete my account' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Current password').fill('correct-account-password');
    await dialog.getByLabel('Type @alice:local to confirm').fill('@alice:local');
    await dialog.getByRole('checkbox', { name: 'Request removal of profile information' }).check();
    await dialog.getByRole('button', { name: 'Permanently deactivate account' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).signedOut)).toBe(message);
    expect(submitted).toMatchObject({ password: 'correct-account-password', confirmation: '@alice:local', erase: true });
    expect(submitted).not.toHaveProperty('historyPolicy');
  });
}
