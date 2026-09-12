import { expect, test, type Page } from '@playwright/test';
const job = () => ({ id: 'operation123456789', roomId: '!voice:local', name: 'Gaming Voice', kind: 'channel', phase: 'review', issue: '', completed: 0,
  targets: [{ id: '!voice:local', name: 'Gaming Voice', kind: 'channel', members: 2, state: 'ready' }] });
async function mount(page: Page, history = false) {
  const requests: string[] = []; let value = job(); let complete = false;
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const accountArtworkOwner=()=>window.account;export const requestApi=async(path,body)=>{const r=await fetch('/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;};` }));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.client;' }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname; requests.push(route.request().method() + ' ' + path);
    if (path.endsWith('/removal')) return route.fulfill({ json: { operation: null } });
    if (path.endsWith('/room-removals')) return route.fulfill({ json: { operations: [{ ...value, phase: 'attention', targets: [{ ...value.targets[0], state: 'submitted' }] }] } });
    if (path.endsWith('/confirm')) {
      expect(route.request().postDataJSON()).toEqual({ confirmation: 'Gaming Voice' }); value.phase = 'ready';
    } else if (path.endsWith('/continue')) {
      value.phase = complete ? 'complete' : 'native_pending'; value.completed = complete ? 1 : 0; value.targets[0].state = complete ? 'complete' : 'submitted';
    }
    await route.fulfill({ json: value });
  });
  await page.route('**/room-removal-test*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta name='viewport' content='width=device-width, initial-scale=1'></head><body><div id='root'></div><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/room-removal.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/room-removal-test' + (history ? '?history' : '')); return { requests, complete: () => { complete = true; } };
}
test('review requires the exact name before submitting and only native completion reports deletion', async ({ page }) => {
  const fixture = await mount(page);
  await page.getByRole('button', { name: 'Review permanent deletion' }).click();
  await expect(page.getByRole('button', { name: 'Delete permanently', exact: true })).toBeDisabled();
  expect(fixture.requests.some(path => /confirm|continue/.test(path))).toBe(false);
  await page.getByRole('textbox', { name: 'Type Gaming Voice to confirm' }).fill('Gaming Voice');
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Removing room');
  await expect(page.getByRole('button', { name: 'Review permanent deletion' })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('0 of 1');
  fixture.complete();
  await expect(page.getByRole('status')).toContainText('Deleted · 1 of 1');
  expect(await page.evaluate(() => (window as any).completed)).toBe(true);
});
test('closing a confirmed deletion stops further browser continuation', async ({ page }) => {
  const fixture = await mount(page);
  await page.getByRole('button', { name: 'Review permanent deletion' }).click();
  await page.getByRole('textbox').fill('Gaming Voice'); await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Ready to continue');
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.waitForTimeout(2200);
  expect(fixture.requests.filter(path => path.endsWith('/continue'))).toHaveLength(0);
});
test('account history is read only until its owner explicitly resumes', async ({ page }) => {
  const fixture = await mount(page, true);
  await page.getByRole('button', { name: 'Gaming Voice · Needs attention' }).click();
  await page.getByRole('button', { name: 'Refresh saved status' }).click();
  expect(fixture.requests.some(path => path.startsWith('POST'))).toBe(false);
});
test('an account change cannot submit the displayed deletion', async ({ page }) => {
  const fixture = await mount(page);
  await page.getByRole('button', { name: 'Review permanent deletion' }).click();
  await page.getByRole('textbox').fill('Gaming Voice');
  await page.evaluate(() => { (window as any).account = {}; });
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  expect(fixture.requests.some(path => path.endsWith('/confirm'))).toBe(false);
});
test('the destructive review fits a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 }); await mount(page);
  await page.getByRole('button', { name: 'Review permanent deletion' }).click();
  await expect(page.getByRole('textbox')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
