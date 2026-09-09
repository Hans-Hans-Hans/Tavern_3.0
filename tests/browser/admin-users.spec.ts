import { test, expect, type Page } from '@playwright/test';

const member = { name: '@member:local', displayname: 'Member', admin: false, deactivated: false, locked: false, creation_ts: 1700000000000, serviceAccount: false, security: { managed: true, email: 'member@example.test', emailVerified: true, mfaMethods: ['totp'], accessBlocked: '', passwordChangeRequired: false } };
const detail = (user = member) => ({ user, security: user.security, serviceAccount: user.serviceAccount, sessions: { items: [{ id: 'session-id', deviceId: 'PHONE', name: 'Phone', createdAt: 1700000000000, lastSeen: 1700000001000, expiresAt: 1900000000000, ip: '10.0.0.5' }], total: 1, next: null }, rooms: { items: ['!chat:local'], total: 1, next: null }, storage: { usedBytes: 1048576, quotaBytes: 10485760, quotaOverrideBytes: null, usageInitialized: true, uncertainReservations: 0 }, audit: [{ id: 1, created: 1700000000, actor: '@owner:local', action: 'user_created', target: user.name, detail: '' }] });
async function fixture(page: Page) {
  await page.route('**/admin-users-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/admin-users.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/admin-users-test');
}

test('filtered user pagination continues after an empty page and uses opaque returned offsets', async ({ page }) => {
  const requests: URL[] = [];
  await page.route('**/api/admin/users?*', route => {
    const url = new URL(route.request().url()); requests.push(url);
    const filtered = url.searchParams.get('mfa') === 'enabled', nextPage = url.searchParams.get('from') === '75';
    return route.fulfill({ json: { users: filtered && !nextPage ? [] : [member], next_token: nextPage ? null : '75', total: filtered ? null : 101, boundedPageFiltering: filtered, scanned: 50 } });
  });
  await fixture(page); await expect(page.getByRole('button', { name: 'Manage @member:local' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Two-step verification', exact: true }).selectOption('enabled');
  await page.getByRole('combobox', { name: 'Sort users by', exact: true }).selectOption('creation_ts');
  await page.getByRole('combobox', { name: 'Sort direction', exact: true }).selectOption('b');
  await page.getByRole('button', { name: 'Apply user filters' }).click();
  await expect(page.getByText('No matching users on this page. Continue to the next page to check more accounts.')).toBeVisible();
  await expect(page.getByText('Page 1 · Matching total unavailable', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next user page' }).click();
  await expect(page.getByRole('button', { name: 'Manage @member:local' })).toBeVisible();
  expect(requests.at(-1)!.searchParams.get('from')).toBe('75'); expect(requests.at(-1)!.searchParams.get('sort')).toBe('creation_ts'); expect(requests.at(-1)!.searchParams.get('dir')).toBe('b');
  await page.getByRole('button', { name: 'Previous user page' }).click();
  await expect(page.getByText('No matching users on this page. Continue to the next page to check more accounts.')).toBeVisible();
  expect(requests.at(-1)!.searchParams.get('from')).toBe('0');
});

test('sensitive account action preserves administrator credentials when requesting email codes and retrying failures', async ({ page }) => {
  await page.route('**/api/admin/users?*', route => route.fulfill({ json: { users: [member], next_token: null, total: 1 } }));
  await page.route('**/api/admin/users/%40member%3Alocal?*', route => route.fulfill({ json: detail() }));
  await page.route('**/api/account/security', route => route.fulfill({ json: { totpEnabled: false, emailMfaEnabled: true } }));
  let emailRequest: any, actionRequests: any[] = [];
  await page.route('**/api/account/security/email-code', route => { emailRequest = route.request().postDataJSON(); return route.fulfill({ json: { challengeId: 'operator-email-challenge' } }); });
  await page.route('**/api/admin/users/%40member%3Alocal/actions', route => { actionRequests.push(route.request().postDataJSON()); return actionRequests.length === 1 ? route.fulfill({ status: 503, json: { error: 'Homeserver temporarily unavailable' } }) : route.fulfill({ json: { ok: true } }); });
  await fixture(page); await page.getByRole('button', { name: 'Manage @member:local' }).click();
  await page.getByRole('tab', { name: 'Security', exact: true }).click(); await page.getByRole('button', { name: 'Reset two-step verification…', exact: true }).click();
  const dialog = page.getByRole('dialog').last(); await expect(dialog.getByRole('button', { name: 'Reset two-step verification', exact: true })).toBeDisabled();
  await dialog.getByLabel('Type @member:local to confirm', { exact: true }).fill('@member:local'); await dialog.getByLabel('Your administrator password').fill('operator-password');
  await dialog.getByRole('button', { name: 'Send administrator email code' }).click(); await expect.poll(() => emailRequest).toEqual({ password: 'operator-password' });
  await expect(dialog.getByLabel('Your administrator password')).toHaveValue('operator-password'); await dialog.getByLabel('Administrator verification code').fill('123456');
  await dialog.getByRole('button', { name: 'Reset two-step verification', exact: true }).click(); await expect(dialog.getByRole('alert')).toHaveText('Homeserver temporarily unavailable');
  await expect(dialog.getByLabel('Your administrator password')).toHaveValue('operator-password'); await expect(dialog.getByLabel('Administrator verification code')).toHaveValue('123456');
  await dialog.getByRole('button', { name: 'Reset two-step verification', exact: true }).click();
  await expect.poll(() => actionRequests.length).toBe(2); expect(actionRequests[1]).toEqual({ action: 'reset_mfa', confirmation: '@member:local', password: 'operator-password', method: 'email', code: '123456', challengeId: 'operator-email-challenge' });
  await expect(page.getByRole('heading', { name: 'Reset two-step verification', exact: true })).toHaveCount(0);
});

test('self access actions are disabled, profile edits omit unchanged privileges, and creation leaves email unverified', async ({ page }) => {
  const owner = { ...member, name: '@owner:local', admin: true }; let updated: any, created: any;
  await page.route('**/api/admin/users?*', route => route.fulfill({ json: { users: [owner], next_token: null, total: 1 } }));
  await page.route('**/api/admin/users/%40owner%3Alocal?*', route => route.fulfill({ json: detail(owner) }));
  await page.route('**/api/admin/users/%40owner%3Alocal', route => { updated = route.request().postDataJSON(); return route.fulfill({ json: owner }); });
  await page.route('**/api/admin/users', route => { created = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { userId: '@newperson:local' } }); });
  await fixture(page); await page.getByRole('button', { name: 'Manage @owner:local' }).click();
  await page.getByRole('tab', { name: 'Security', exact: true }).click(); await expect(page.getByRole('button', { name: 'Deactivate account…' })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Require password change…' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Profile', exact: true }).click(); await page.getByRole('button', { name: 'Edit account', exact: true }).click();
  let dialog = page.getByRole('dialog').last(); await expect(dialog.getByRole('checkbox', { name: 'Instance administrator' })).toBeDisabled(); await dialog.getByLabel('Display name').fill('New owner name'); await dialog.getByRole('button', { name: 'Save account' }).click();
  await expect.poll(() => updated).toEqual({ displayname: 'New owner name' }); await page.getByRole('dialog', { name: 'User administration', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Create user', exact: true }).click(); dialog = page.getByRole('dialog');
  await dialog.getByLabel('Username', { exact: true }).fill('newperson'); await dialog.getByLabel('Display name').fill('New person'); await dialog.getByLabel('Email (optional)').fill('new@example.test'); await dialog.getByLabel('Initial password').fill('newperson-password'); await dialog.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect.poll(() => created).toEqual({ username: 'newperson', displayName: 'New person', email: 'new@example.test', password: 'newperson-password', admin: false });
  expect(created.emailVerified).toBeUndefined(); expect(created.verified).toBeUndefined();
});
