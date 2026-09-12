import { expect, test, type Page } from '@playwright/test';
import ts from 'typescript';
import { readFileSync } from 'node:fs';

// Run the real shared account-data mutation in the browser. Other Matrix startup
// services are outside this fixture; the room/client itself is the actual SDK.
const source = ts.createSourceFile('matrix.ts', readFileSync('lib/matrix.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const mutation = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'mutateMatrixAccountData')!.getText(source);
const boundary = ts.transpileModule("let client=null;const accountQueues=new Map();const notify=()=>window.dmFixture.emit();export const fixtureSetDmClient=c=>{client=c};export const getMatrixClient=()=>client;export const onMatrixUpdate=fn=>{window.dmFixture.listeners.add(fn);return()=>window.dmFixture.listeners.delete(fn)};" + mutation, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
async function fixture(page: Page, workspace = false, hash = '') {
  const names = [...readFileSync('lib/matrix.ts', 'utf8').matchAll(/export (?:async )?function (\w+)/g)].map(match => match[1]).filter(name => !['getMatrixClient', 'onMatrixUpdate', 'mutateMatrixAccountData'].includes(name));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: boundary + (workspace ? names.map(name => 'export const ' + name + '=(...args)=>window.matrixBoundary(' + JSON.stringify(name) + ',args);').join('\n') : '') }));
  if (!workspace) {
    await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const accountArtworkOwner=()=>window.dmFixture.account;' }));
    await page.route(url => url.pathname === '/lib/interactions.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const blockUser=(...args)=>window.dmFixture.blockUser(...args);' }));
  }
  await page.route('**/config.json', route => route.fulfill({ json: { homeserverUrl: 'http://127.0.0.1:5173', serverRolePolicy: true, callsEnabled: false } }));
  await page.route('**/dm-requests-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/' + (workspace ? 'dm-workspace' : 'dm-requests') + '.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/dm-requests-test' + hash); await expect(workspace ? page.locator('.profile-button') : page.getByRole('button', { name: 'Accept message request' })).toBeVisible();
}

test('native invitation inbox shows identity and scope without fetching previews, then classifies the accepted room', async ({ page }) => {
  await fixture(page); await expect(page.getByText('Invited by @alice:local')).toBeVisible(); await expect(page.getByText(/does not prove who else can read/)).toBeVisible();
  await expect(page.locator('img,video,audio')).toHaveCount(0); expect(await page.evaluate(() => (window as any).dmFixture.calls)).toEqual([]);
  await page.getByRole('button', { name: 'Accept message request' }).click(); await expect(page.getByText('Opened conversation !request:local')).toBeVisible(); await expect(page.getByText('No message requests.', { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => ({ mapping: (window as any).dmFixture.mapping, calls: (window as any).dmFixture.calls })); expect(saved.mapping['@alice:local']).toEqual(['!request:local']); expect(saved.mapping['@existing:local']).toEqual(['!existing:local']); expect(saved.calls.filter((call: any) => call.path.startsWith('/join/'))).toHaveLength(1);
});
test('joined room remains recoverable when the Messages list fails, with no second join', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { (window as any).dmFixture.failMap = true; }); await page.getByRole('button', { name: 'Accept message request' }).click();
  await expect(page.getByRole('alert')).toContainText('You joined the room'); await expect(page.getByRole('button', { name: 'Retry adding to Messages' })).toBeEnabled(); await expect(page.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0); expect(await page.evaluate(() => (window as any).dmOpened)).toEqual([]);
  await page.evaluate(() => { (window as any).dmFixture.failMap = false; }); await page.getByRole('button', { name: 'Retry adding to Messages' }).click(); await expect(page.getByText('Opened conversation !request:local')).toBeVisible(); expect(await page.evaluate(() => (window as any).dmFixture.calls.filter((call: any) => call.path.startsWith('/join/')).length)).toBe(1);
});
test('decline removes a real invitation without joining or loading messages', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Decline', exact: true }).click(); await expect(page.getByRole('status')).toHaveText('Message request declined.');
  expect(await page.evaluate(() => (window as any).dmFixture.calls.map((call: any) => call.path))).toEqual(['/rooms/!request%3Alocal/leave']);
});
test('block needs confirmation and preserves a successful block when declining needs retry', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { (window as any).dmFixture.failLeave = true; }); await page.getByRole('button', { name: 'Block sender' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Existing shared room memberships and history remain'); expect(await page.evaluate(() => (window as any).dmFixture.calls)).toEqual([]);
  await page.getByRole('button', { name: 'Block and decline' }).click(); await expect(page.getByRole('alert')).toContainText('The user is blocked.'); await expect(page.getByRole('button', { name: 'Accept message request' })).toBeDisabled();
  await page.evaluate(() => { (window as any).dmFixture.failLeave = false; }); await page.getByRole('button', { name: 'Decline', exact: true }).click(); await expect(page.getByText('No message requests.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).dmFixture.calls.filter((call: any) => call.method === 'BLOCK').length)).toBe(1);
});
test('old acceptance completion cannot overwrite the next account inbox or open its room', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { const f = (window as any).dmFixture; f.beforeJoin = () => new Promise<void>(resolve => { (window as any).releaseOldJoin = resolve; }); }); await page.getByRole('button', { name: 'Accept message request' }).click();
  await page.waitForFunction(() => !!(window as any).releaseOldJoin); await page.evaluate(() => (window as any).replaceDmOwner()); await expect(page.getByText('New account request', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).releaseOldJoin()); await expect(page.getByRole('button', { name: 'Accept message request' })).toBeEnabled(); await expect(page.getByRole('alert')).toHaveCount(0); expect(await page.evaluate(() => (window as any).dmOpened)).toEqual([]); expect(await page.evaluate(() => (window as any).dmFixture.calls)).toEqual([]);
});
test('invitation withdrawn while block confirmation is open cannot authorize the stale action', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Block sender' }).click(); await page.evaluate(() => { const f = (window as any).dmFixture; f.member(f.room, 'leave'); }); await page.getByRole('button', { name: 'Block and decline' }).click();
  await expect(page.getByRole('alert')).toContainText('changed or was withdrawn'); expect(await page.evaluate(() => (window as any).dmFixture.calls)).toEqual([]);
});

test('Workspace Messages entry accepts into the recipient sidebar and opens the actual joined room', async ({ page }) => {
  await fixture(page, true); await page.getByRole('button', { name: 'Message requests (1)', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Message requests', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).workspaceCalls.some((call: any) => call[0] === 'messages' && call[2]?.conversation === '!request:local'))).toBe(false);
  await page.getByRole('button', { name: 'Accept message request' }).click(); await expect(page.getByRole('heading', { name: 'Alice', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Message requests (0)', exact: true })).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).dmFixture.mapping['@alice:local'])).toEqual(['!request:local']); await expect(page.locator('.channel-sidebar .channel-link').filter({ hasText: 'Alice' })).toBeVisible();
});
test('generic invitation review and invitation deep links route direct messages through explicit inbox consent', async ({ page }) => {
  await fixture(page, true); await page.getByRole('button', { name: 'View invitations', exact: true }).click(); await page.getByRole('button', { name: 'Review message request' }).click();
  await expect(page.getByRole('button', { name: 'Accept message request' })).toBeVisible(); expect(await page.evaluate(() => (window as any).dmFixture.calls)).toEqual([]);
  await fixture(page, true, '#room=%21request%3Alocal'); await expect(page.getByRole('button', { name: 'Accept message request' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).workspaceCalls.some((call: any) => call[0] === 'messages' && call[2]?.conversation === '!request:local'))).toBe(false);
});


test('channel context notification settings opens the selected room notification editor', async ({ page }) => {
  await fixture(page, true);
  await page.getByRole('button', { name: 'Lobby', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Notification settings', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('tab', { name: 'Notifications', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(sheet.getByRole('heading', { name: 'Channel notifications', exact: true })).toBeVisible();
  await expect(sheet.getByRole('combobox', { name: 'Notify me about', exact: true })).toHaveValue('inherit');
  await expect(page.getByRole('heading', { name: 'Lobby', level: 1, exact: true })).toBeHidden();
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lobby', level: 1, exact: true })).toBeVisible();
});
