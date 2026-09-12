import { test, expect, type Page } from '@playwright/test';
async function fixture(page: Page, strict = false) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.client;export const onMatrixUpdate=fn=>{window.listeners.push(fn);return()=>{window.listeners=window.listeners.filter(v=>v!==fn);};};' }));
  // Keep requestApi's production URL/credential behavior; only account ownership
  // and the HTTP server boundary belong to this component fixture.
  await page.route(url => url.pathname === '/lib/api.ts' && !url.searchParams.has('channel-real-api'), route => route.fulfill({ contentType: 'text/javascript', body: 'export { requestApi } from "/lib/api.ts?channel-real-api";export const accountArtworkOwner=()=>window.accountOwner;' }));
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    expect(route.request().method()).toBe('GET');
    if (path === '/api/channels/admission/capability') return route.fulfill({ json: await page.evaluate(() => ({ version: 1, available: (window as any).admissionReady !== false })) });
    if (path === '/api/servers/!server%3Alocal/channels/available') return route.fulfill({ json: await page.evaluate(() => structuredClone((window as any).catalog)) });
    return route.fulfill({ status: 404, json: { error: 'Unknown fixture HTTP endpoint.' } });
  });
  await page.route(url => url.pathname === '/lib/instance.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const readInstanceConfig=async()=>({serverRolePolicy:window.policyEnabled!==false,callsEnabled:window.callsEnabled!==false});' }));
  await page.route(url => url.pathname === '/lib/community.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const readServerLayout=()=>structuredClone(window.layout);export function normalizeServerLayout(raw,ids){const value=structuredClone(raw||{version:1,categories:[],channels:[]});for(const id of ids||[])if(!value.channels.some(c=>c.id===id))value.channels.push({id,category:''});return value;}` }));
  await page.route('**/channel-creation-test*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id='root'></div><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/channel-creation.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/channel-creation-test' + (strict ? '?strict' : '')); await expect(page.getByRole('textbox', { name: 'Channel name', exact: true })).toBeVisible();
}

test('private voice creation chooses actual roles and members and saves restricted admission before inviting', async ({ page }) => {
  await fixture(page);
  await page.getByRole('radio', { name: /^Voice/ }).check();
  await page.getByRole('textbox', { name: 'Channel name', exact: true }).fill('Private lounge');
  await page.getByRole('checkbox', { name: 'Private channel with selected roles and members', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Member', exact: true }).check();
  await page.getByText('Invite members now', { exact: false }).click(); await page.getByRole('checkbox', { name: /Peer/ }).check();
  await page.getByRole('button', { name: 'Create voice channel', exact: true }).click();
  await expect(page.getByText('Private roles and members saved.', { exact: true })).toBeVisible();
  const result = await page.evaluate(() => { const w = window as any; return { writes: w.writes, created: w.created.length, roles: w.states['!server:local'].find((event: any) => event.type === 'io.tavern.roles').content }; });
  expect(result.created).toBe(1);
  expect(result.roles.channelAdmissions['!created-1:local']).toEqual({ roleIds: ['everyone'], userIds: ['@peer:local'] });
  expect(result.writes.findIndex((row: any) => row[0] === 'io.tavern.roles')).toBeLessThan(result.writes.findIndex((row: any) => row[0] === 'invite'));
  expect(result.writes.find((row: any) => row[0] === 'm.room.join_rules' && row[2].join_rule === 'restricted')).toBeTruthy();
});

async function managedChannel(page: Page) {
  await fixture(page);
  await page.getByRole('textbox', { name: 'Channel name', exact: true }).fill('Managed channel');
  await page.getByRole('button', { name: 'Create text channel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Managed channel was created' })).toBeVisible();
  await page.evaluate(() => (window as any).manage('!created-1:local'));
  await expect(page.getByRole('button', { name: 'Save channel access', exact: true })).toBeEnabled();
}

test('private access editor preserves a partial save, retries the same room and reloads confirmed role selection', async ({ page }) => {
  await managedChannel(page);
  await page.getByRole('checkbox', { name: 'Use selected roles and members' }).check();
  await page.getByRole('checkbox', { name: 'Member', exact: true }).check();
  await page.getByRole('textbox', { name: 'Specific members' }).fill('@peer:local');
  await page.evaluate(() => { (window as any).failRule = true; });
  await page.getByRole('button', { name: 'Save channel access', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Join rule save temporarily unavailable');
  await expect(page.getByRole('textbox', { name: 'Specific members' })).toHaveValue('@peer:local');
  await page.getByRole('button', { name: 'Save channel access', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Private channel access saved');
  await page.getByRole('button', { name: 'Reload saved access' }).click();
  await expect(page.getByRole('checkbox', { name: 'Member', exact: true })).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Specific members' })).toHaveValue('@peer:local');
  expect(await page.evaluate(() => (window as any).created.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).writes.filter((row: any) => row[0] === 'io.tavern.roles' && row[2].channelAdmissionVersion).length)).toBe(1);
  await page.getByRole('checkbox', { name: 'Use selected roles and members' }).uncheck();
  await page.getByRole('button', { name: 'Save channel access', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Invite-only access saved');
  const end = await page.evaluate(() => (window as any).writes.slice(-2));
  expect(end.map((row: any) => row[0])).toEqual(['m.room.join_rules', 'io.tavern.roles']);
  expect(end[0][2].join_rule).toBe('invite'); expect(end[1][2].channelAdmissions).toEqual({});
});

test('private controls require live enforcement and stay inside a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 650 }); await managedChannel(page);
  await page.getByRole('checkbox', { name: 'Use selected roles and members' }).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { (window as any).admissionReady = false; });
  await page.getByRole('button', { name: 'Reload saved access' }).click();
  await expect(page.getByRole('status')).toContainText('Private-channel enforcement is not ready');
  await expect(page.getByRole('button', { name: 'Save channel access', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).writes.some((row: any) => row[0] === 'io.tavern.roles'))).toBe(false);
});

test('eligible-channel browser requires an explicit join, retains rejected joins and opens after native membership', async ({ page }) => {
  await managedChannel(page);
  await page.getByRole('checkbox', { name: 'Use selected roles and members' }).check();
  await page.getByRole('checkbox', { name: 'Member', exact: true }).check();
  await page.getByRole('button', { name: 'Save channel access', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Private channel access saved');
  await page.evaluate(() => { const w = window as any; w.actor = '@peer:local'; w.accountOwner = {}; w.opened = []; w.writes = []; w.catalog = { channels: [{ id: '!created-1:local', name: 'Managed channel', kind: 'text', joined: false }], next: null }; w.browse(); });
  await page.getByRole('button', { name: 'Browse private channels', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Managed channel');
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
  await page.evaluate(() => { (window as any).failJoin = true; });
  await page.getByRole('button', { name: 'Join channel', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Private access changed');
  expect(await page.evaluate(() => (window as any).opened)).toEqual([]);
  await page.evaluate(() => { (window as any).failJoin = false; });
  await page.getByRole('button', { name: 'Join channel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).opened)).toEqual(['!created-1:local']);
  expect(await page.evaluate(() => (window as any).writes)).toEqual([['join', '!created-1:local']]);
});

test('typed creation exposes real voice settings, category placement and explicit invitation outcomes', async ({ page }) => {
  await fixture(page); await page.getByRole('radio', { name: /^Voice/ }).check();
  await expect(page.getByText(/creating the channel does not turn on a microphone/i)).toBeVisible();
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
