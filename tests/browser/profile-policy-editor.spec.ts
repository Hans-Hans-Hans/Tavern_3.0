import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, query = '') {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const mutateMatrixAccountData=()=>{throw new Error("Unexpected navigation account-data write in profile-policy-editor fixture");};export const getMatrixClient=()=>window.profileFixture?.client;export const onMatrixUpdate=fn=>{window.profileFixture.listeners.add(fn);return()=>window.profileFixture.listeners.delete(fn)};' }));
  // Keep the actual profile editor, policy resolution and publishers. Unrelated
  // server administration panels are outside this focused browser fixture.
  const boundaries: Record<string, string> = { 'category-menu': 'CategoryMenu', 'server-roles': 'ServerRoleBadges', 'category-permissions': 'CategoryPermissions', 'account-creation-date': 'AccountCreationDate', 'server-nickname': 'ServerNicknameNotice', 'server-afk': 'ServerAfkSettings', 'server-eligibility': 'ServerEligibilitySettings', 'server-profile-policy': 'ServerProfilePolicySettings' };
  for (const [path, name] of Object.entries(boundaries)) await page.route(url => url.pathname === `/app/${path}.tsx`, route => route.fulfill({ contentType: 'application/javascript', body: `export const ${name}=()=>null;` }));
  await page.route(url => url.pathname === '/app/role-identity.tsx', route => route.fulfill({ contentType: 'text/javascript', body: 'export const ServerRoleBadges=()=>null;export const ServerRoleName=({children})=>children;' }));
  await page.route('**/profile-editor-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/profile-policy-editor.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/profile-editor-test?' + query); await expect(page.getByLabel('About me')).toBeVisible();
}

test('actual server editor retains the old profile until explicit Apply limits, then publishes a compliant draft', async ({ page }) => {
  await fixture(page);
  const original = await page.evaluate(() => (window as any).profileFixture.originalProfile);
  await expect(page.getByLabel('About me')).toHaveValue(original.bio); await expect(page.getByLabel('About me')).toHaveAttribute('maxlength', '160');
  await expect(page.getByLabel('Link 1 URL')).toHaveValue('https://example.com/'); await expect(page.getByLabel('Link 1 URL')).toBeDisabled();
  await expect(page.getByLabel('Field 1 value')).toHaveValue('Remote'); await expect(page.getByLabel('Field 1 value')).toBeDisabled();
  expect(await page.evaluate(() => (window as any).profileFixture.writes)).toEqual([]);
  await page.getByRole('button', { name: 'Apply server limits' }).click();
  await expect(page.getByLabel('About me')).toHaveValue(original.bio.slice(0, 160)); await expect(page.getByLabel('Status', { exact: true })).toHaveValue(original.status.slice(0, 40));
  await expect(page.getByLabel('Link 1 URL')).toHaveCount(0); await expect(page.getByLabel('Field 1 value')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect.poll(() => page.evaluate(() => (window as any).profileFixture.changed)).toBe(1);
  const f = await page.evaluate(() => { const f = (window as any).profileFixture; return { writes: f.writes, account: f.account, original: f.originalProfile }; });
  expect(f.writes[0][2]['io.tavern.profile']).toMatchObject({ bio: original.bio.slice(0, 160), links: [], fields: [], serverOverride: '!server:local' });
  expect(f.account.links).toHaveLength(1); expect(f.original).toEqual(original);
});

test('global editor explains projected copies and preserves its full profile while each server receives its limits', async ({ page }) => {
  await fixture(page, 'global');
  await expect(page.getByText('Each server applies its own limits to the profile copy shared there; your account profile is preserved.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Link 1 URL')).toBeEnabled(); await expect(page.getByLabel('About me')).toHaveAttribute('maxlength', '1000');
  await page.getByLabel('Display name').fill('Updated global name'); await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).profileFixture.changed)).toBe(1);
  const state = await page.evaluate(() => { const f = (window as any).profileFixture; return { account: f.account, original: f.globalProfile, writes: f.writes }; });
  expect(state.account).toEqual({ ...state.original, name: 'Updated global name' });
  expect(state.writes.find((write: any[]) => write[0] === '!channel:local')[2]['io.tavern.profile']).toMatchObject({ links: [], fields: [], bio: state.original.bio.slice(0, 160), status: state.original.status.slice(0, 40) });
  expect(state.writes.find((write: any[]) => write[0] === '!server:local')[2].displayname).toBe('Chosen server name');
});

test('Use global profile displays the actual projected result without relying on a membership sync update', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).profileFixture; f.client.sendStateEvent = async (...args: any[]) => { f.writes.push(args); return { event_id: '$accepted-without-sync' }; }; });
  await page.getByRole('button', { name: 'Use global profile' }).click(); await expect.poll(() => page.evaluate(() => (window as any).profileFixture.changed)).toBe(1);
  const global = await page.evaluate(() => (window as any).profileFixture.globalProfile);
  await expect(page.getByLabel('Server nickname')).toHaveValue(global.name); await expect(page.getByLabel('About me')).toHaveValue(global.bio.slice(0, 160));
  await expect(page.getByLabel('Link 1 URL')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Apply server limits' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).profileFixture.writes[0][2]['io.tavern.profile'].serverOverride)).toBe('');
});

test('unavailable rules disable publication and reset while preserving the draft for policy repair', async ({ page }) => {
  await fixture(page);
  const before = await page.getByLabel('About me').inputValue();
  await page.evaluate(() => { const f = (window as any).profileFixture; f.server.put('io.tavern.server.profile_policy', { enabled: true }); for (const listener of f.listeners) listener(); });
  await expect(page.getByRole('region', { name: 'Server profile limits' })).toContainText('unavailable');
  await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Use global profile' })).toBeDisabled();
  await expect(page.getByLabel('About me')).toHaveValue(before);
  await page.evaluate(() => { const f = (window as any).profileFixture; f.server.put('io.tavern.server.profile_policy', { version: 1, enabled: false, allowLinks: true, allowCustomFields: true, maxBioLength: 1000, maxStatusLength: 160 }); for (const listener of f.listeners) listener(); });
  await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled(); await expect(page.getByLabel('About me')).toHaveValue(before);
});

test('native rejection keeps the edited draft visible and leaves a successful retry possible', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Apply server limits' }).click(); await page.getByLabel('About me').fill('My retained server draft');
  await page.evaluate(() => { (window as any).profileFixture.rejectWrite = true; });
  await page.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('server rejected');
  await expect(page.getByLabel('About me')).toHaveValue('My retained server draft'); await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).profileFixture.rejectWrite = false; }); await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).profileFixture.changed)).toBe(1); await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const change of ['account', 'server']) test(`${change} replacement during reset cannot overwrite the new editor or report old success`, async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).profileFixture; const gate = new Promise<void>(resolve => { f.release = resolve; }); f.beforeRead = () => { f.beforeRead = null; f.pending = true; return gate; }; });
  await page.getByRole('button', { name: 'Use global profile' }).click(); await page.waitForFunction(() => (window as any).profileFixture.pending);
  await page.evaluate(kind => { const f = (window as any).profileFixture; if (kind === 'account') { f.actor = '@member:local'; f.client = { ...f.client }; for (const listener of f.listeners) listener(); } else f.showServer(f.second.roomId); }, change);
  await expect(page.getByLabel('Server nickname')).toHaveValue(change === 'account' ? '@member:local' : 'Second server profile');
  await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
  await page.getByLabel('About me').fill('New scope draft'); await page.evaluate(() => (window as any).profileFixture.release());
  await expect.poll(() => page.evaluate(() => (window as any).profileFixture.reads.length)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect.poll(() => page.evaluate(() => (window as any).profileFixture.changed)).toBe(1);
  await expect(page.getByLabel('About me')).toHaveValue('New scope draft'); await expect(page.getByRole('alert')).toHaveCount(0);
  const writes = await page.evaluate(() => (window as any).profileFixture.writes);
  expect(writes.at(-1)[0]).toBe(change === 'account' ? '!server:local' : '!second:local'); expect(writes.at(-1)[3]).toBe(change === 'account' ? '@member:local' : '@owner:local');
  if (change === 'account') expect(writes).toHaveLength(1);
});

test('changing the profile scope clears an unsubmitted image crop from the previous server', async ({ page }) => {
  await fixture(page);
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4; const context = canvas.getContext('2d')!; context.fillStyle = 'blue'; context.fillRect(0, 0, 4, 4); return canvas.toDataURL('image/png').split(',')[1]; });
  await page.getByLabel('Choose avatar').setInputFiles({ name: 'old-server-avatar.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.getByRole('button', { name: 'Use cropped image' })).toBeEnabled();
  await page.evaluate(() => { const f = (window as any).profileFixture; f.showServer(f.second.roomId); });
  await expect(page.getByLabel('Server nickname')).toHaveValue('Second server profile');
  await expect(page.getByRole('button', { name: 'Use cropped image' })).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Crop preview' })).toHaveCount(0);
});
