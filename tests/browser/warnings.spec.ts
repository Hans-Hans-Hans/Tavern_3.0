import { test, expect, type Page } from '@playwright/test';
const record = { id: 17, roomId: '!room:local', targetId: '@member:local', actor: '@mod:local', reason: 'Please stop repeating the same post.', createdAt: 1788912000000, status: 'active', read: false };
async function fixture(page: Page) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=fn=>{window.refreshFixture=fn;return()=>{};};' }));
  await page.route('**/warnings-test*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/warnings.tsx')).mountFixture();</script></body></html>` }));
}
test('private warnings require confirmation, retain a rejected draft, and withdraw with history intact', async ({ page }) => {
  await fixture(page); const issued: any[] = []; let saved = false, withdrawn = false;
  await page.route('**/api/moderation/warnings**', route => {
    const request = route.request(), url = new URL(request.url());
    expect(request.headers()['x-tavern-device']).toBe('MODERATOR-DEVICE');
    if (url.pathname.endsWith('/withdraw')) { expect(request.postDataJSON()).toEqual({ confirmation: '@member:local' }); withdrawn = true; return route.fulfill({ json: { ...record, status: 'withdrawn' } }); }
    if (request.method() === 'POST') { issued.push(request.postDataJSON()); if (issued.length === 1) return route.fulfill({ status: 403, json: { error: 'Membership changed. Refresh before retrying.' } }); saved = true; return route.fulfill({ status: 201, json: record }); }
    expect(url.searchParams.get('roomId')).toBe('!room:local'); expect(url.searchParams.get('targetId')).toBe('@member:local');
    return route.fulfill({ json: { warnings: saved ? [{ ...record, status: withdrawn ? 'withdrawn' : 'active' }] : [], next: null } });
  });
  await page.goto('/warnings-test'); await page.getByRole('button', { name: 'Issue warning…' }).click();
  const submit = page.getByRole('button', { name: 'Send warning to member' }); await expect(submit).toBeDisabled();
  await page.getByLabel('Private warning reason').fill(record.reason); await page.getByLabel('Type @member:local to confirm').fill('@wrong:local'); await expect(submit).toBeDisabled();
  await page.getByLabel('Type @member:local to confirm').fill('@member:local'); await submit.click();
  await expect(page.getByRole('alert')).toContainText('Membership changed'); await expect(page.getByLabel('Private warning reason')).toHaveValue(record.reason);
  await submit.click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByText(record.reason, { exact: true })).toBeVisible();
  expect(issued[1]).toEqual({ roomId: '!room:local', targetId: '@member:local', reason: record.reason, confirmation: '@member:local' });
  await page.getByRole('button', { name: 'Withdraw warning #17…' }).click(); const withdraw = page.getByRole('button', { name: 'Withdraw warning', exact: true }); await expect(withdraw).toBeDisabled();
  await page.getByLabel('Type @member:local to confirm').fill('@member:local'); await withdraw.click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByText('Warning #17 · Withdrawn', { exact: false })).toBeVisible(); await expect(page.getByText(record.reason, { exact: true })).toBeVisible();
});
test('warning inbox reads the actual displayed cursor and retains withdrawn records', async ({ page }) => {
  await fixture(page); let read = false;
  await page.route('**/api/moderation/warnings/**', route => {
    if (route.request().method() === 'POST') { expect(route.request().postDataJSON()).toEqual({ throughId: 17 }); read = true; return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { warnings: [{ ...record, read }, { ...record, id: 12, status: 'withdrawn', read: true }], unread: read ? 0 : 1, next: null } });
  });
  await page.goto('/warnings-test?inbox'); await expect(page.getByRole('heading', { name: 'Your warning inbox · 1 unread' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark through this page as read' }).click(); await expect(page.getByRole('heading', { name: 'Your warning inbox · 0 unread' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark through this page as read' })).toBeDisabled(); await expect(page.getByText('Warning #12 · Withdrawn', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: /Withdraw warning/ })).toHaveCount(0);
});
test('losing moderation authority removes warning reasons and action controls', async ({ page }) => {
  await fixture(page); let requests = 0;
  await page.route('**/api/moderation/warnings?*', route => { requests++; return route.fulfill({ json: { warnings: [record], next: null } }); });
  await page.goto('/warnings-test'); await expect(page.getByText(record.reason, { exact: true })).toBeVisible();
  await page.evaluate(() => { const w = window as any; w.authorized = false; w.refreshFixture(); });
  await expect(page.getByText(record.reason, { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Issue warning…' })).toHaveCount(0);
  await page.goto('/warnings-test?unauthorized'); await expect(page.locator('#root')).toBeEmpty(); expect(requests).toBe(1);
});
