import { test, expect, type Page } from '@playwright/test';
async function fixture(page: Page, strict = false) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.client;export const onMatrixUpdate=fn=>{window.listeners.push(fn);return()=>{window.listeners=window.listeners.filter(v=>v!==fn);};};' }));
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const accountArtworkOwner=()=>window.accountOwner;' }));
  await page.route(url => url.pathname === '/lib/instance.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const readInstanceConfig=async()=>({serverRolePolicy:window.policyEnabled!==false,callsEnabled:window.callsEnabled!==false});' }));
  await page.route(url => url.pathname === '/lib/community.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const readServerLayout=()=>structuredClone(window.layout);export function normalizeServerLayout(raw,ids){const value=structuredClone(raw||{version:1,categories:[],channels:[]});for(const id of ids||[])if(!value.channels.some(c=>c.id===id))value.channels.push({id,category:''});return value;}` }));
  await page.route('**/channel-creation-test*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id='root'></div><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/channel-creation.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/channel-creation-test' + (strict ? '?strict' : '')); await expect(page.getByRole('textbox', { name: 'Channel name', exact: true })).toBeVisible();
}

test('typed creation exposes real voice settings, category placement and explicit invitation outcomes', async ({ page }) => {
  await fixture(page); await page.getByRole('radio', { name: /^Voice/ }).check();
  await expect(page.getByText(/Creating the channel does not turn on a microphone/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Channel name', exact: true }).fill('Project lounge');
  await page.getByRole('textbox', { name: 'Channel description' }).fill('Talk through design decisions');
  await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('projects'); await page.getByRole('combobox', { name: 'Chat slow mode', exact: true }).selectOption('10');
  await page.getByText('Invite members now', { exact: false }).click(); await page.getByRole('checkbox', { name: /Peer/ }).check();
  await page.getByRole('button', { name: 'Create voice channel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project lounge was created' })).toBeVisible();
  await expect(page.getByText('Category placement saved.', { exact: true })).toBeVisible();
  const value = await page.evaluate(() => { const w = window as any; return { created: w.created, writes: w.writes, opened: w.opened }; });
  expect(value.created).toHaveLength(1); expect(value.created[0].invite).toBeUndefined();
  expect(value.created[0].initial_state.find((event: any) => event.type === 'io.tavern.channel').content).toMatchObject({ kind: 'voice', slowModeSeconds: 10, archived: false });
  expect(value.writes.map((write: any) => write[0])).toEqual(['join', 'm.space.child', 'io.tavern.server.layout', 'invite']);
  expect(value.opened).toEqual(['!created-1:local']);
});

test('partial creation offers same-room repair and keeps pending invites separate from confirmed invitations', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { (window as any).failLayout = true; });
  await page.getByRole('textbox', { name: 'Channel name', exact: true }).fill('Design archive');
  await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('projects');
  await page.getByText('Invite members now', { exact: false }).click(); await page.getByRole('checkbox', { name: /Peer/ }).check();
  await page.getByRole('button', { name: 'Create text channel', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Category save temporarily unavailable');
  await expect(page.getByText('Invitations pending: Peer.')).toBeVisible();
  expect(await page.evaluate(() => (window as any).opened)).toEqual([]);
  await page.getByRole('button', { name: 'Retry remaining setup' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText(/1 member invitation confirmed/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).created.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).opened)).toEqual(['!created-1:local']);
});

test('server or account replacement retires an in-flight form and suppresses its old completion', async ({ page }) => {
  for (const replace of ['server', 'account']) {
    await fixture(page); await page.evaluate(() => { (window as any).holdCreate = true; });
    await page.getByRole('textbox', { name: 'Channel name', exact: true }).fill('Retired draft');
    await page.getByRole('button', { name: 'Create text channel', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!(window as any).resolveCreate)).toBe(true);
    await page.evaluate(kind => { const w = window as any; if (kind === 'account') { w.accountOwner = {}; w.listeners.forEach((fn: () => void) => fn()); } else w.render('!other:local'); }, replace);
    await expect(page.getByRole('textbox', { name: 'Channel name', exact: true })).toHaveValue('');
    await page.getByRole('textbox', { name: 'Channel name', exact: true }).fill('Current draft');
    await page.evaluate(() => (window as any).resolveCreate());
    await expect(page.getByRole('textbox', { name: 'Channel name', exact: true })).toHaveValue('Current draft');
    await expect(page.getByRole('heading', { name: /was created/ })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).opened)).toEqual([]);
  }
});

test('descriptions distinguish moderator-only posts, forum discussions and media guidance without hidden restrictions', async ({ page }) => {
  await fixture(page);
  await page.getByRole('radio', { name: /^Announcement/ }).check(); await expect(page.getByText(/Only authorized moderators can publish posts/)).toBeVisible();
  await page.getByRole('radio', { name: /^Forum/ }).check(); await expect(page.getByText(/discussion posts with titles and tags/)).toBeVisible();
  await page.getByRole('radio', { name: /^Media/ }).check(); await expect(page.getByText(/does not enforce a file-only restriction/)).toBeVisible();
  await page.evaluate(() => { const w = window as any; w.callsEnabled = false; w.render(); }); await page.getByRole('radio', { name: /^Video/ }).check();
  await expect(page.getByRole('status')).toContainText('Calls are currently disabled');
});

test('mobile form stays within the viewport and exposes every type', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 650 }); await fixture(page);
  await expect(page.getByRole('radio')).toHaveCount(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('textbox', { name: 'Channel name', exact: true }).fill('Mobile channel');
  await page.getByRole('button', { name: 'Create text channel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mobile channel was created' })).toBeVisible();
});

test('StrictMode effect replay keeps the mounted creation form usable without duplicate creation', async ({ page }) => {
  await fixture(page, true);
  await page.getByRole('textbox', { name: 'Channel name', exact: true }).fill('Strict mode channel');
  await page.getByRole('button', { name: 'Create text channel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Strict mode channel was created' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).created.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).opened)).toEqual(['!created-1:local']);
});

test('the opening callback can reject its continuation after account or server replacement', async ({ page }) => {
  for (const replacement of ['account', 'server']) {
    await fixture(page); await page.evaluate(() => { (window as any).holdOpen = true; });
    await page.getByRole('textbox', { name: 'Channel name', exact: true }).fill('Created in old view');
    await page.getByRole('button', { name: 'Create text channel', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).resolveOpen)).toBe('function');
    expect(await page.evaluate(() => (window as any).openCurrent())).toBe(true);
    await page.evaluate(kind => { const w = window as any; if (kind === 'account') { w.accountOwner = {}; w.listeners.forEach((fn: () => void) => fn()); } else w.render('!other:local'); }, replacement);
    await expect(page.getByRole('textbox', { name: 'Channel name', exact: true })).toHaveValue('');
    await page.getByRole('textbox', { name: 'Channel name', exact: true }).fill('Current draft');
    expect(await page.evaluate(() => (window as any).openCurrent())).toBe(false);
    await page.evaluate(() => (window as any).resolveOpen());
    await expect.poll(() => page.evaluate(() => (window as any).openFinished)).toBe(true);
    await expect(page.getByRole('textbox', { name: 'Channel name', exact: true })).toHaveValue('Current draft');
    expect(await page.evaluate(() => (window as any).opened)).toEqual([]);
    expect(await page.evaluate(() => (window as any).created.length)).toBe(1);
  }
});
