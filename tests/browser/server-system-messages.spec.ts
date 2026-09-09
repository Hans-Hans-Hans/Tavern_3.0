import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, options: { unconfigured?: boolean; restricted?: boolean } = {}) {
  const data: any = { enabled: !options.unconfigured, ready: !options.unconfigured, settings: null, eventId: null, destinations: options.unconfigured ? [] : [{ hookId: 'notices', roomId: '!channel:local', name: 'Welcome bot' }], counts: { pending: 2, sent: 3, cancelled: 1 }, configurationRevision: options.unconfigured ? '' : 'config-1' };
  const backend = { data, writes: [] as any[], beforeGet: null as (() => Promise<void>) | null, rejected: false, gets: 0 };
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const getMatrixClient=()=>window.systemFixture?.client;export const onMatrixUpdate=fn=>{window.systemFixture.listeners.add(fn);return()=>window.systemFixture.listeners.delete(fn)};' }));
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const accountArtworkOwner=()=>window.systemFixture.accountOwner;export const isManagedAccount=()=>window.systemFixture.managed;export async function requestApi(path,body,method=body===undefined?"GET":"POST"){const response=await fetch("/api"+path,{method,headers:{"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error),{status:response.status});return data}' }));
  await page.route('**/api/servers/**/system-messages', async route => {
    if (route.request().method() === 'GET') { backend.gets++; await backend.beforeGet?.(); return route.fulfill({ json: backend.data }); }
    if (backend.rejected) return route.fulfill({ status: 503, json: { error: 'The encrypted bot is temporarily unavailable.' } });
    const body = route.request().postDataJSON(); backend.writes.push(body); backend.data.settings = body.settings; backend.data.eventId = '$route-' + backend.writes.length;
    return route.fulfill({ json: { eventId: backend.data.eventId } });
  });
  await page.route('**/system-messages-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/server-system-messages.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/system-messages-test?' + (options.restricted ? 'restricted' : '')); await page.waitForFunction(() => !!(window as any).systemFixture);
  return backend;
}
async function enableDraft(page: Page) { await page.getByRole('checkbox', { name: 'Post system notices' }).check(); await page.getByLabel('Encrypted webhook destination', { exact: true }).selectOption('notices'); await page.getByRole('checkbox', { name: 'Member leaves' }).check(); await page.getByLabel('Confirm server ID').fill('!server:local'); }

test('system notices show off until explicitly confirmed and report honest delivery outcomes', async ({ page }) => {
  const backend = await fixture(page); await expect(page.getByText('System notices: Off', { exact: true })).toBeVisible();
  await enableDraft(page); await page.getByLabel('Confirm server ID').fill('server:local'); await expect(page.getByRole('button', { name: 'Save system notice settings' })).toBeDisabled();
  await page.getByLabel('Confirm server ID').fill('!server:local'); await page.getByRole('button', { name: 'Save system notice settings' }).click();
  await expect(page.getByRole('status')).toContainText('settings saved'); await expect(page.getByText('System notices: Enabled', { exact: true })).toBeVisible();
  expect(backend.writes).toEqual([{ confirmation: '!server:local', settings: { version: 1, enabled: true, channelId: '!channel:local', hookId: 'notices', joins: true, leaves: true, 'io.tavern.previous_event': null } }]);
  await expect(page.getByText('Queued: 2 · Sent: 3 · Cancelled: 1', { exact: true })).toBeVisible(); await expect(page.getByText(/does not confirm that every member received or read it/)).toBeVisible();
});

test('unconfigured installations cannot enable and no destinations or sends are invented', async ({ page }) => {
  const backend = await fixture(page, { unconfigured: true }); await expect(page.getByText('System notices: Unconfigured', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Post system notices' })).toBeDisabled(); await expect(page.getByLabel('Encrypted webhook destination')).toBeDisabled(); expect(backend.writes).toEqual([]);
});

test('changed routes retain the draft until explicit reload and native rejection supports retry', async ({ page }) => {
  const backend = await fixture(page); await enableDraft(page);
  backend.data.settings = { version: 1, enabled: false, channelId: '', hookId: '', joins: false, leaves: true, 'io.tavern.previous_event': null }; backend.data.eventId = '$elsewhere';
  await page.getByRole('button', { name: 'Save system notice settings' }).click(); await expect(page.getByRole('alert')).toContainText('settings changed');
  await expect(page.getByRole('checkbox', { name: 'Post system notices' })).toBeChecked(); await expect(page.getByLabel('Encrypted webhook destination')).toHaveValue('notices'); expect(backend.writes).toEqual([]);
  await page.getByRole('button', { name: 'Reload settings and delivery status' }).click(); await expect(page.getByRole('checkbox', { name: 'Post system notices' })).not.toBeChecked();
  await enableDraft(page); backend.rejected = true; await page.getByRole('button', { name: 'Save system notice settings' }).click(); await expect(page.getByRole('alert')).toHaveText('The encrypted bot is temporarily unavailable.'); await expect(page.getByRole('checkbox', { name: 'Member leaves' })).toBeChecked();
  backend.rejected = false; await page.getByRole('button', { name: 'Save system notice settings' }).click(); await expect(page.getByRole('status')).toContainText('settings saved'); expect(backend.writes[0].settings['io.tavern.previous_event']).toBe('$elsewhere');
});

test('the current native/custom authority gates reads and permission loss hides loaded settings', async ({ page }) => {
  const restricted = await fixture(page, { restricted: true }); await expect(page.getByText(/native state authority and permission/)).toBeVisible(); expect(restricted.gets).toBe(0);
  await fixture(page); await expect(page.getByText('System notices: Off', { exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).systemFixture; f.server.membership = 'leave'; for (const listener of f.listeners) listener(); });
  await expect(page.getByLabel('Encrypted webhook destination')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Save system notice settings' })).toHaveCount(0);
});

test('account replacement during a fresh save cannot submit or restore the old draft', async ({ page }) => {
  const backend = await fixture(page); await enableDraft(page);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); backend.beforeGet = async () => { backend.beforeGet = null; await gate; };
  await page.getByRole('button', { name: 'Save system notice settings' }).click(); await expect.poll(() => backend.gets).toBe(2);
  await page.evaluate(() => { const f = (window as any).systemFixture; f.accountOwner = {}; f.client = { ...f.client }; for (const listener of f.listeners) listener(); });
  await expect(page.getByRole('checkbox', { name: 'Post system notices' })).not.toBeChecked(); release();
  await expect(page.getByLabel('Confirm server ID')).toHaveValue(''); await expect(page.getByRole('alert')).toHaveCount(0);
  await enableDraft(page); await page.getByRole('button', { name: 'Save system notice settings' }).click(); await expect(page.getByRole('status')).toContainText('settings saved'); expect(backend.writes).toHaveLength(1);
});
