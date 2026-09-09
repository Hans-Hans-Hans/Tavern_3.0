import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=()=>()=>{};' }));
  await page.route('**/temporary-bans-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/temporary-bans.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/temporary-bans-test');
}
const restriction = { roomId: '!room:local', targetId: '@member:local', eventId: null, until: 0, active: false, actor: null, reason: '' };

test('temporary ban uses typed confirmation, shows partial removal and lifts without claiming rejoin', async ({ page }) => {
  let current: any = restriction; const actions: any[] = [];
  await page.route('**/api/moderation/temporary-bans**', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { restriction: current, inherited: [], membership: 'join', scope: 'room' } });
    const body = route.request().postDataJSON(); actions.push(body);
    current = { ...restriction, active: body.action === 'apply', until: body.action === 'apply' ? Date.now() + 3600000 : 0, eventId: '$changed' };
    return route.fulfill({ json: { restrictionApplied: current.active, until: current.until, eventId: '$changed', membershipRemoved: false, scope: 'room', message: current.active ? 'Temporary restriction is active, but membership removal was not confirmed. The member may still read this room.' : 'Temporary restriction lifted. The member was not automatically rejoined.' } });
  });
  await fixture(page); await expect(page.getByRole('button', { name: 'Apply temporary ban', exact: true })).toBeDisabled();
  await page.getByLabel('Reason visible in room state', { exact: true }).fill('Repeated spam');
  await page.getByRole('combobox', { name: 'Temporary ban duration', exact: true }).selectOption('3600');
  await page.getByLabel('Type @member:local to confirm the temporary ban change').fill('@wrong:local');
  await expect(page.getByRole('button', { name: 'Apply temporary ban', exact: true })).toBeDisabled();
  await page.getByLabel('Type @member:local to confirm the temporary ban change').fill('@member:local');
  await page.getByRole('button', { name: 'Apply temporary ban', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('member may still read');
  expect(actions[0]).toEqual({ action: 'apply', roomId: '!room:local', targetId: '@member:local', confirmation: '@member:local', previousEventId: null, reason: 'Repeated spam', durationSeconds: 3600 });
  await page.getByLabel('Type @member:local to confirm the temporary ban change').fill('@member:local');
  await page.getByRole('button', { name: 'Lift temporary ban', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('not automatically rejoined');
  expect(actions[1].previousEventId).toBe('$changed'); expect(actions[1].action).toBe('lift');
});

test('stale temporary ban review cannot be resubmitted until refreshed', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/moderation/temporary-bans**', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { restriction: { ...restriction, eventId: ++reads === 1 ? '$old' : '$latest' }, inherited: [], membership: 'join', scope: 'room' } })
    : route.fulfill({ status: 409, json: { error: 'This temporary ban changed. Refresh it before submitting again.' } }));
  await fixture(page); await page.getByLabel('Reason visible in room state', { exact: true }).fill('Repeated spam');
  await page.getByLabel('Type @member:local to confirm the temporary ban change').fill('@member:local');
  await page.getByRole('button', { name: 'Apply temporary ban', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Refresh it'); await expect(page.getByRole('button', { name: 'Apply temporary ban', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review temporary ban', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply temporary ban', exact: true })).toBeDisabled(); expect(reads).toBe(2);
});
