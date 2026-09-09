import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, query = '', splash = 'mxc://local/shared-invitation') {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  await page.goto('about:blank');
  const png = Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 12; canvas.height = 4; canvas.getContext('2d')!.fillRect(0, 0, 12, 4); return canvas.toDataURL('image/png').split(',')[1]; }), 'base64');
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=()=>()=>{};export const matrixApi=async()=>{};' }));
  await page.route('**/api/matrix/_matrix/client/v1/media/thumbnail/**', async route => { requests.push({ url: route.request().url(), headers: await route.request().allHeaders() }); await route.fulfill({ contentType: 'image/png', body: png }); });
  await page.route('**/api/invitations/preview/*', route => route.fulfill({ json: { roomName: 'Gaming', roomId: '!server:local', requiresEmail: !splash, splashMxc: splash } }));
  await page.route('**/api/invitations/redeem', route => route.fulfill({ json: { roomId: '!server:local' } }));
  await page.route('**/server-branding-test*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/server-branding.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/server-branding-test?' + query);
  await page.waitForFunction(() => typeof (window as any).unmount === 'function');
  return requests;
}

test('server identity crops uploaded invitation artwork and preserves the existing banner and welcome', async ({ page }) => {
  await fixture(page);
  const art = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 40; canvas.getContext('2d')!.fillRect(0, 0, 120, 40); return canvas.toDataURL('image/png').split(',')[1]; });
  await page.getByLabel('Choose invitation splash', { exact: true }).setInputFiles({ name: 'splash.png', mimeType: 'image/png', buffer: Buffer.from(art, 'base64') });
  await page.getByRole('button', { name: 'Use cropped image', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove invitation splash', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save server identity', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).writes.length)).toBe(1);
  const result = await page.evaluate(() => ({ writes: (window as any).writes, uploads: (window as any).uploads }));
  expect(result.uploads[0].type).toBe('image/webp'); expect(result.uploads[0].size).toBeLessThan(2 * 1024 * 1024);
  expect(result.writes[0][2]).toEqual({ banner: 'mxc://local/banner', welcome: 'Keep these welcome rules', accent: '#123456', inviteSplash: 'mxc://local/cropped-splash', 'io.tavern.previous_event': '$io.tavern.server.branding:0' });
});

test('identity controls hide without custom authority and stale branding must be reloaded', async ({ page }) => {
  await fixture(page, 'restricted');
  await expect(page.getByRole('button', { name: 'Save server identity' })).toHaveCount(0);
  await fixture(page);
  await page.evaluate(() => { const w = window as any; w.room.put('io.tavern.server.branding', { banner: 'mxc://local/new-banner', welcome: 'Changed remotely' }); });
  await page.getByRole('button', { name: 'Save server identity' }).click();
  await expect(page.getByRole('alert')).toContainText('Server branding changed');
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
  await page.getByRole('button', { name: 'Reload server details' }).click();
  await expect(page.getByRole('textbox', { name: 'Welcome and rules' })).toHaveValue('Changed remotely');
  await page.evaluate(() => { const w = window as any; w.beforeRead = () => { w.powers.users['@owner:local'] = 0; }; });
  await page.getByRole('button', { name: 'Save server identity' }).click();
  await expect(page.getByRole('alert')).toContainText('Permissions or memberships changed');
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
});

test('invitation acceptance renders authenticated bounded artwork without a Matrix client or token leakage', async ({ page }) => {
  const token = 'an-invitation-token-that-must-stay-secret', requests = await fixture(page, 'invite=' + token);
  await expect(page.getByRole('img', { name: 'Invitation artwork' })).toBeVisible();
  await expect.poll(() => page.getByRole('img', { name: 'Invitation artwork' }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(12);
  expect(await page.evaluate(() => (window as any).fixtureClient)).toBeNull();
  expect(requests).toHaveLength(1); expect(requests[0].url).not.toContain(token);
  expect(requests[0].headers.authorization).toBe('Bearer cookie-session:D1');
  expect(requests[0].headers['x-tavern-device']).toBe('D1');
  expect(requests[0].headers.referer).toBeUndefined();
  expect(await page.getByRole('img', { name: 'Invitation artwork' }).getAttribute('src')).toMatch(/^blob:/);
  await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).joined)).toBe('!server:local');
  expect(page.url()).not.toContain(token);
});

test('ineligible invitation preview does not fetch or show artwork', async ({ page }) => {
  const requests = await fixture(page, 'invite=restricted-secret', '');
  await expect(page.getByText('This invitation requires a verified email matching its restrictions.')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Invitation artwork' })).toHaveCount(0);
  expect(requests).toHaveLength(0);
});
