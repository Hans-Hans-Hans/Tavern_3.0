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
  await page.route('**/dm-requests-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/' + (workspace ? 'dm-workspace' : 'dm-requests') + '.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/dm-requests-test' + hash); await expect(workspace ? page.locator('.profile-button:visible, .mobile-profile:visible') : page.getByRole('button', { name: 'Accept message request' })).toBeVisible();
}

async function channelContextAction(page: Page, trigger: ReturnType<Page['locator']>, action: string) {
  await page.evaluate(() => {
    const w = window as any; w.channelMenuTrace = [];
    w.stopChannelMenuTrace?.();
    const record = (event: Event) => {
      const target = event.target as Element;
      if (w.channelMenuTrace.length < 40) w.channelMenuTrace.push({ type: event.type, tag: target?.tagName,
        role: target?.getAttribute?.('role'), slot: target?.getAttribute?.('data-slot'),
        menu: !!document.querySelector('[role="menu"]'), dialog: !!document.querySelector('[role="dialog"]') });
    };
    const types = ['pointerdown', 'pointerup', 'click', 'contextmenu', 'focusin'];
    for (const type of types) document.addEventListener(type, record, true);
    w.stopChannelMenuTrace = () => { for (const type of types) document.removeEventListener(type, record, true); };
  });
  try { await trigger.click({ button: 'right' }); await page.getByRole('menuitem', { name: action, exact: true }).click({ timeout: 5000 }); }
  catch (error) { console.error('Channel menu interaction:', await page.evaluate(() => (window as any).channelMenuTrace).catch(() => 'unavailable')); throw error; }
  finally { await page.evaluate(() => (window as any).stopChannelMenuTrace?.()).catch(() => {}); }
}

test('responsive navigation centers the DM icon on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await fixture(page, true, '?management=1');
  const dm = page.getByRole('button', { name: 'Direct messages', exact: true });
  for (const selected of [false, true]) {
    if (selected) await dm.click();
    const button = (await dm.boundingBox())!, icon = (await dm.locator('svg').boundingBox())!;
    expect(Math.abs(button.x + button.width / 2 - icon.x - icon.width / 2)).toBeLessThan(1);
    expect(Math.abs(button.y + button.height / 2 - icon.y - icon.height / 2)).toBeLessThan(1);
  }
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toHaveCount(0);
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
  await page.screenshot({ path: 'work/navigation-desktop.png' });
});

for (const width of [320, 390]) test(`responsive navigation opens servers and DMs on a ${width}px phone`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await fixture(page, true, '?management=1');
  const dock = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(dock).toBeVisible();
  const bounds = (await dock.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await page.getByRole('button', { name: 'Browse servers', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Games server', exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Gaming Voice', exact: true })).toBeVisible();
  const sheet = (await drawer.boundingBox())!;
  expect(sheet.width).toBeLessThanOrEqual(width);
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
  await page.screenshot({ path: `work/navigation-phone-${width}-drawer.png` });
  await drawer.getByRole('button', { name: 'Lobby', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Lobby', level: 1, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Browse servers', exact: true }).click();
  await drawer.getByRole('button', { name: 'Gaming Voice', exact: true }).click();
  const selected = page.url();
  await page.getByRole('button', { name: 'Browse servers', exact: true }).click();
  await drawer.getByRole('button', { name: 'Close navigation', exact: true }).click();
  expect(page.url()).toBe(selected);
  await expect(page.getByRole('heading', { name: 'Gaming Voice', level: 1, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Your mentions', exact: true }).click();
  await page.getByRole('button', { name: 'Browse servers', exact: true }).click();
  await drawer.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Gaming Voice', level: 1, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Browse direct messages', exact: true }).click();
  await expect(drawer.locator('.workspace-select')).toContainText('Direct messages');
  await expect(drawer.locator('.channel-navigation')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'New message', exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Browse servers', exact: true }).click();
  await expect(drawer.locator('.workspace-select')).toContainText('Games server');
  await drawer.getByRole('button', { name: 'Lobby', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
  await page.screenshot({ path: `work/navigation-phone-${width}.png` });
});

test('responsive navigation retains phone controls in landscape and releases desktop overlays', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }));
  await page.setViewportSize({ width: 844, height: 390 });
  await fixture(page, true, '?management=1');
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Browse servers', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Games server', exact: true }).click();
  await drawer.getByRole('button', { name: 'Lobby', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
  await page.screenshot({ path: 'work/navigation-landscape.png' });
  await page.getByRole('button', { name: 'Browse servers', exact: true }).click();
  await page.evaluate(() => Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Desktop browser' }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Direct messages', exact: true }).click();
  await expect(page.locator('.workspace-select')).toContainText('Direct messages');
});

test('responsive navigation keeps the phone composer above the keyboard and preserves zoom', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
  const page = await context.newPage();
  try {
    await fixture(page, true, '?management=1');
    const dock = page.getByRole('navigation', { name: 'Mobile navigation' });
    await page.getByRole('button', { name: 'Browse servers', exact: true }).tap();
    const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await drawer.getByRole('button', { name: 'Games server', exact: true }).tap();
    await expect(drawer.locator('.workspace-select')).toContainText('Games server');
    await drawer.getByRole('button', { name: 'Lobby', exact: true }).tap();
    await expect(drawer).toHaveCount(0);
    const input = page.getByRole('textbox', { name: 'Message Lobby', exact: true });
    await input.focus();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 520 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(dock).toBeHidden();
    await expect(page.locator('.tavern-root')).toHaveAttribute('data-keyboard', 'open');
    await expect.poll(async () => (await page.locator('.tavern-root').boundingBox())?.height).toBe(520);
    const composer = (await input.boundingBox())!;
    expect(composer.y).toBeGreaterThanOrEqual(0);
    expect(composer.y + composer.height).toBeLessThanOrEqual(520);
    await page.screenshot({ path: 'work/navigation-phone-keyboard.png' });
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 844 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(dock).toBeVisible();
    await expect.poll(async () => (await page.locator('.tavern-root').boundingBox())?.height).toBe(844);
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'scale', { configurable: true, value: 2 });
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 422 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(dock).toBeVisible();
    expect((await page.locator('.tavern-root').boundingBox())?.height).toBe(844);
  } finally { await context.close().catch(() => {}); }
});

test('responsive navigation gives a roomy touch tablet the full server columns', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' });
  const page = await context.newPage();
  try {
    await fixture(page, true, '?management=1');
    await expect(page.locator('.tavern-root')).toHaveAttribute('data-interface', 'desktop');
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Games server', exact: true }).tap();
    await expect(page.locator('.workspace-select')).toContainText('Games server');
    await expect(page.getByRole('button', { name: 'Gaming Voice', exact: true })).toBeVisible();
  } finally { await context.close().catch(() => {}); }
});

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
  await channelContextAction(page, page.getByRole('button', { name: 'Lobby', exact: true }), 'Notification settings');
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('tab', { name: 'Notifications', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(sheet.getByRole('heading', { name: 'Channel notifications', exact: true })).toBeVisible();
  await expect(sheet.getByRole('combobox', { name: 'Notify me about', exact: true })).toHaveValue('inherit');
  await expect(page.getByRole('heading', { name: 'Lobby', level: 1, exact: true })).toBeHidden();
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lobby', level: 1, exact: true })).toBeVisible();
});


test('owner opens a different voice channel and keeps its native settings sections usable through sync', async ({ page }) => {
  await page.route('**/api/channels/admission/capability', route => route.fulfill({ json: { version: 1, available: true } }));
  await fixture(page, true, '?management=1');
  await page.getByRole('button', { name: 'Games server', exact: true }).click();
  const voice = page.locator('.channel-navigation').getByRole('button', { name: 'Gaming Voice', exact: true });
  for (let cycle = 0; cycle < 3; cycle++) {
    await channelContextAction(page, voice, 'Edit channel & permissions');
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('tab', { name: 'Permissions', exact: true }).click();
    const access = sheet.getByRole('region', { name: 'Private channel access', exact: true });
    const enabled = access.getByRole('checkbox', { name: 'Use selected roles and members', exact: true });
    await expect(enabled).toBeEnabled();
    if (cycle) await expect(enabled).toBeChecked(); else await enabled.check();
    await access.getByRole('checkbox', { name: 'Gaming', exact: true }).check();
    await page.evaluate(() => (window as any).dmFixture.emit());
    await expect(access.getByRole('checkbox', { name: 'Gaming', exact: true })).toBeChecked();
    await sheet.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(sheet.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Gaming Voice');
    await sheet.getByRole('tab', { name: 'Permissions', exact: true }).click();
    await expect(access.getByRole('checkbox', { name: 'Gaming', exact: true })).toBeChecked();
    await access.getByRole('button', { name: 'Save channel access', exact: true }).click();
    await expect(access.getByRole('status')).toContainText('Private channel access saved');
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(voice).toBeVisible();
  }
});

test('channel edit context action respects the topic permission ceiling used by the editor', async ({ page }) => {
  await fixture(page, true, '?management=1');
  await page.getByRole('button', { name: 'Games server', exact: true }).click();
  await page.evaluate(() => {
    const f = (window as any).dmFixture;
    f.setNativeState(f.client.getRoom('!voice:local'), 'm.room.power_levels', { users: { [f.actor]: 100 }, state_default: 50, events: { 'm.room.topic': 101 } });
    f.emit();
  });
  await page.getByRole('button', { name: 'Gaming Voice', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Notification settings', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Edit channel & permissions', exact: true })).toHaveCount(0);
});

test('opening right-button release cannot select a context action before a deliberate click', async ({ page }) => {
  await fixture(page, true);
  // Linux opens the menu on button-down. Its initiating button-up can land on
  // the new menu during the opening animation; no item received button-down.
  await page.getByRole('button', { name: 'Lobby', exact: true }).dispatchEvent('contextmenu', { button: 2, clientX: 170, clientY: 200 });
  const action = page.getByRole('menuitem', { name: 'Notification settings', exact: true });
  await expect(action).toBeVisible();
  await action.dispatchEvent('pointerup', { button: 2, pointerType: 'mouse', bubbles: true, cancelable: true });
  await expect(action).toBeVisible({ timeout: 1000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await action.click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Channel notifications', exact: true })).toBeVisible();
});
