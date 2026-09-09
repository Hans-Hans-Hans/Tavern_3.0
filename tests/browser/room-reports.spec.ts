import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, submit = false) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=()=>()=>{};' }));
  await page.route('**/room-reports-test*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/room-reports.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/room-reports-test' + (submit ? '?submit=1' : ''));
}
const report = { id: 7, kind: 'message', roomId: '!room:local', eventId: '$event', targetId: '@member:local', reason: 'Reported harassment', evidence: 'Manually supplied evidence', reporter: '@reporter:local', createdAt: 1700000000000, updatedAt: 1700000000000, status: 'open', note: '', reviewer: null, revision: 0 };

test('report audience defaults to private, discloses opt-in evidence readers and resets for the next report', async ({ page }) => {
  const submitted: any[] = [];
  await page.route('**/api/reports', route => { submitted.push(route.request().postDataJSON()); return route.fulfill({ status: 201, json: { id: submitted.length, status: 'open' } }); });
  await fixture(page, true);
  await expect(page.getByRole('combobox', { name: 'Who can read this report' })).toHaveValue('platform');
  await expect(page.getByRole('note')).toContainText('will not appear in the room moderator queue');
  await page.getByLabel('Reason', { exact: true }).fill('Private report about a moderator');
  await page.getByRole('button', { name: 'Submit report', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(submitted[0].audience).toBe('platform');
  await page.getByRole('button', { name: 'Report another message' }).click();
  await page.getByRole('combobox', { name: 'Who can read this report' }).selectOption('room');
  await expect(page.getByRole('note')).toContainText('including a moderator you are reporting');
  await page.getByLabel('Reason', { exact: true }).fill('Shared report about repeated spam');
  await page.getByLabel('Evidence you choose to share (optional)').fill('Only this excerpt is shared');
  await page.getByRole('button', { name: 'Submit report', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(submitted[1].audience).toBe('room'); expect(submitted[1].evidence).toBe('Only this excerpt is shared');
  await page.getByRole('button', { name: 'Report another message' }).click();
  await expect(page.getByRole('combobox', { name: 'Who can read this report' })).toHaveValue('platform'); await expect(page.getByLabel('Evidence you choose to share (optional)')).toHaveValue('');
});

test('room review pages through scoped reports and requires refresh after conflicting edits', async ({ page }) => {
  const queries: URL[] = [], updates: any[] = []; let detailReads = 0;
  await page.route('**/api/moderation/reports?*', route => { const url = new URL(route.request().url()); queries.push(url); return route.fulfill({ json: { reports: [report], next: url.searchParams.has('before') ? null : 7 } }); });
  await page.route('**/api/moderation/reports/7?*', route => route.fulfill({ json: { ...report, revision: ++detailReads === 1 ? 0 : 4, note: detailReads === 1 ? '' : 'A newer reviewer note' } }));
  await page.route('**/api/moderation/reports/7', route => { updates.push(route.request().postDataJSON()); return updates.length === 1 ? route.fulfill({ status: 409, json: { error: 'Another moderator changed this review. Refresh the report before saving again.' } }) : route.fulfill({ json: { ...report, revision: 5 } }); });
  await fixture(page); await page.getByRole('button', { name: 'Older shared reports' }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible(); expect(queries.at(-1)!.searchParams.get('before')).toBe('7'); expect(queries.at(-1)!.searchParams.get('roomId')).toBe('!room:local');
  await page.getByRole('button', { name: 'Review shared report #7', exact: true }).click();
  const form = page.getByRole('form', { name: 'Room report review' }); await expect(form).toContainText('Manually supplied evidence');
  await form.getByRole('combobox', { name: 'Moderator review status' }).selectOption('resolved'); await form.getByLabel('Room moderator note').fill('My private moderator note');
  await form.getByRole('button', { name: 'Save room review' }).click(); await expect(page.getByRole('alert')).toContainText('Another moderator');
  await expect(form.getByRole('button', { name: 'Save room review' })).toBeDisabled(); await expect(form.getByLabel('Room moderator note')).toHaveValue('My private moderator note');
  await form.getByRole('button', { name: 'Refresh selected report' }).click(); await expect(form.getByLabel('Room moderator note')).toHaveValue('A newer reviewer note');
  await form.getByRole('combobox', { name: 'Moderator review status' }).selectOption('resolved'); await form.getByRole('button', { name: 'Save room review' }).click();
  await expect(page.getByText('Room moderator review saved.', { exact: true })).toBeVisible(); expect(updates[1]).toEqual({ roomId: '!room:local', status: 'resolved', note: 'A newer reviewer note', revision: 4 });
});

test('revoked moderator access removes loaded evidence and the review form', async ({ page }) => {
  let denied = false;
  await page.route('**/api/moderation/reports?*', route => denied ? route.fulfill({ status: 403, json: { error: 'Your room moderation permission changed.' } }) : route.fulfill({ json: { reports: [report], next: null } }));
  await page.route('**/api/moderation/reports/7?*', route => route.fulfill({ json: report }));
  await fixture(page); await page.getByRole('button', { name: 'Review shared report #7', exact: true }).click(); await expect(page.getByRole('blockquote')).toContainText('Manually supplied evidence');
  denied = true; await page.getByRole('button', { name: 'Refresh room reports' }).click();
  await expect(page.getByRole('alert')).toContainText('permission changed'); await expect(page.getByRole('form', { name: 'Room report review' })).toHaveCount(0); await expect(page.getByText('Manually supplied evidence', { exact: true })).toHaveCount(0);
});
