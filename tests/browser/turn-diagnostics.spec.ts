import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, options: { deny?: boolean; holdTurn?: boolean; expire?: boolean; missingTtl?: boolean } = {}) {
  const calls: { path: string; headers: Record<string, string> }[] = [], consoleMessages: string[] = [];
  let release!: () => void, block = new Promise<void>(r => { release = r; });
  page.on('console', event => consoleMessages.push(event.text()));
  await page.route('**/api/admin/**', route => route.fulfill({ json: { users: 1, rooms: 1, checks: [{ component: 'TURN', status: 'not_tested', detail: 'Server HTTP cannot prove public UDP.' }], checkedAt: Date.now() } }));
  let admins = 0, revoked = false;
  await page.route('**/api/auth/session', route => { admins++; calls.push({ path: new URL(route.request().url()).pathname, headers: route.request().headers() }); return route.fulfill({ json: { userId: '@admin:local', deviceId: 'TURN-DEVICE', baseUrl: 'http://127.0.0.1:5173/api/matrix', admin: !options.deny && !revoked, passwordChangeRequired: false, mfaEnrollmentRequired: false } }); });
  await page.route('**/api/matrix/**', async route => {
    calls.push({ path: new URL(route.request().url()).pathname, headers: route.request().headers() });
    if (options.holdTurn) await block;
    await route.fulfill({ json: { uris: ['turn:turn.example.test:3478?transport=udp'], username: 'short-lived-user', password: 'TURN-FIXTURE-SECRET', ...(options.missingTtl ? {} : { ttl: options.expire ? 0 : 3600 }) } }).catch(() => {});
  });
  await page.route('**/turn-diagnostics-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/turn-diagnostics.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/turn-diagnostics-test'); await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Browser TURN test' }); await expect(panel).toBeVisible();
  return { calls, consoleMessages, panel, release: () => release(), revoke: () => { revoked = true; }, admins: () => admins };
}

test('actual AdminConsole uses a request-only SDK and native relay candidate semantics without capture or exposing secrets', async ({ page }) => {
  const f = await fixture(page); await f.panel.getByRole('button', { name: 'Test TURN allocation' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).turnFixture.ready)).toBe(true);
  expect(await page.evaluate(() => (window as any).turnFixture.emit('host'))).toEqual({ type: 'host', protocol: 'udp' });
  await expect(f.panel.getByRole('status')).toContainText('Checking');
  expect(await page.evaluate(() => (window as any).turnFixture.emit('relay'))).toEqual({ type: 'relay', protocol: 'udp' });
  await expect(f.panel.getByRole('status')).toContainText('Relay candidate obtained. Relay candidate protocol: UDP.');
  expect(f.admins()).toBe(2);
  const native = f.calls.filter(call => call.path.includes('/api/matrix/'));
  expect(native.map(call => call.path)).toEqual(['/api/matrix/_matrix/client/v3/voip/turnServer']);
  expect(native[0].headers.authorization).toBe('Bearer cookie-session:TURN-DEVICE'); expect(native[0].headers['x-tavern-device']).toBe('TURN-DEVICE');
  const resources = await page.evaluate(() => { const f = (window as any).turnFixture; return { capture: f.captures, closed: f.peers[0].closed, channel: f.peers[0].channelClosed, policy: f.peers[0].configuration.iceTransportPolicy }; });
  expect(resources).toEqual({ capture: 0, closed: true, channel: true, policy: 'relay' });
  await expect(page.locator('body')).not.toContainText('TURN-FIXTURE-SECRET'); await expect(page.locator('body')).not.toContainText('192.0.2.123'); await expect(page.locator('body')).not.toContainText('10.0.0.55');
  expect(f.consoleMessages.join('\n')).not.toContain('TURN-FIXTURE-SECRET');
  await expect(f.panel).toContainText('It does not verify a complete call'); await expect(page.getByText('not_tested', { exact: true })).toBeVisible();
});

test('current native admin denial prevents the credential request and final revocation suppresses allocation success', async ({ page }) => {
  let f = await fixture(page, { deny: true }); await f.panel.getByRole('button', { name: 'Test TURN allocation' }).click();
  await expect(f.panel.getByRole('status')).toContainText('administrator access could not be verified'); expect(f.calls).toHaveLength(1);
  f = await fixture(page); await f.panel.getByRole('button', { name: 'Test TURN allocation' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).turnFixture.ready)).toBe(true);
  f.revoke(); await page.evaluate(() => (window as any).turnFixture.emit());
  await expect(f.panel.getByRole('status')).toContainText('administrator access could not be verified');
  expect(await page.evaluate(() => (window as any).turnFixture.peers[0].closed)).toBe(true);
});

test('cancel during authenticated credential fetch suppresses late peer creation', async ({ page }) => {
  const f = await fixture(page, { holdTurn: true }); await f.panel.getByRole('button', { name: 'Test TURN allocation' }).click();
  await expect.poll(() => f.calls.filter(call => call.path.includes('/api/matrix/')).length).toBe(1);
  await f.panel.getByRole('button', { name: 'Cancel TURN test' }).click(); await expect(f.panel.getByRole('status')).toHaveText('TURN test cancelled.');
  f.release(); await page.waitForTimeout(30); expect(await page.evaluate(() => (window as any).turnFixture.peers)).toEqual([]);
});

for (const action of ['navigation', 'account', 'demotion'] as const) test(`${action} closes an allocated test peer before any late candidate can publish`, async ({ page }) => {
  const f = await fixture(page); await f.panel.getByRole('button', { name: 'Test TURN allocation' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).turnFixture.ready)).toBe(true);
  if (action === 'navigation') await page.getByRole('button', { name: 'Overview', exact: true }).click();
  else await page.evaluate(action => { const f = (window as any).turnFixture; action === 'account' ? f.replaceAccount() : f.demote(); }, action);
  await expect.poll(() => page.evaluate(() => (window as any).turnFixture.peers[0].closed)).toBe(true);
  await page.evaluate(() => (window as any).turnFixture.emit());
  await expect(page.locator('body')).not.toContainText('Relay candidate obtained');
  expect(await page.evaluate(() => (window as any).turnFixture.peers[0].channelClosed)).toBe(true);
});

test('15-second browser deadline closes RTC resources and expired credentials never start ICE', async ({ page }) => {
  let f = await fixture(page); await page.clock.install(); await f.panel.getByRole('button', { name: 'Test TURN allocation' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).turnFixture.ready)).toBe(true);
  await page.clock.runFor(15000); await expect(f.panel.getByRole('status')).toContainText('timed out after 15 seconds');
  expect(await page.evaluate(() => (window as any).turnFixture.peers[0].closed)).toBe(true);
  f = await fixture(page, { expire: true }); await f.panel.getByRole('button', { name: 'Test TURN allocation' }).click();
  await expect(f.panel.getByRole('status')).toContainText('Current TURN credentials are unavailable'); expect(await page.evaluate(() => (window as any).turnFixture.peers)).toEqual([]);
});

test('the real SDK missing-TTL NaN expiry cannot start a browser allocation', async ({ page }) => {
  const f = await fixture(page, { missingTtl: true }); await f.panel.getByRole('button', { name: 'Test TURN allocation' }).click();
  await expect(f.panel.getByRole('status')).toContainText('Current TURN credentials are unavailable');
  expect(f.calls.filter(call => call.path.includes('/api/matrix/'))).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).turnFixture.peers)).toEqual([]);
});
