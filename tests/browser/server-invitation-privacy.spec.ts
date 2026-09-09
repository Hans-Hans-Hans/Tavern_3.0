import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, initial = {}) {
  const backend = { data: { servers: {}, invalid: false, revision: 'a'.repeat(64), invitations: 'contacts', ...initial } as any,
    writes: [] as any[], error: '', delay: null as null | (() => Promise<void>), gets: 0 };
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const getMatrixClient=()=>window.privacyFixture?.client;export const onMatrixUpdate=fn=>{window.privacyFixture.listeners.add(fn);return()=>window.privacyFixture.listeners.delete(fn)}' }));
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const accountArtworkOwner=()=>window.privacyFixture?.account;export const isManagedAccount=()=>true;export async function requestApi(path,body,method){const response=await fetch("/api"+path,{method,headers:{"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data}' }));
  await page.route('**/api/social/server-invitation-privacy', async route => {
    if (route.request().method() === 'GET') { backend.gets++; const response = structuredClone(backend.data); await backend.delay?.(); return route.fulfill({ json: response }); }
    const sent = route.request().postDataJSON(); backend.writes.push(sent);
    if (backend.error) return route.fulfill({ status: 409, json: { error: backend.error } });
    if (sent.revision !== backend.data.revision) return route.fulfill({ status: 409, json: { error: 'Preferences changed. Reload before saving.' } });
    backend.data = { ...backend.data, servers: sent.servers, invalid: false, revision: 'b'.repeat(64) };
    return route.fulfill({ json: backend.data });
  });
  await page.route('**/server-invitation-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/server-invitation-privacy.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/server-invitation-test'); return backend;
}

test('server restrictions preserve global preference and send only the selected bounded map and revision', async ({ page }) => {
  const backend = await fixture(page);
  const choice = page.getByLabel('Invitation restriction for !server:test'); await expect(choice).toHaveValue('inherit');
  await expect(page.getByLabel('Invitation restriction for !channel:test')).toHaveCount(0);
  await choice.selectOption('nobody'); await page.getByRole('button', { name: 'Save server invitation preferences', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Server invitation preferences saved.');
  expect(backend.writes).toEqual([{ servers: { '!server:test': 'nobody' }, revision: 'a'.repeat(64) }]);
  expect(backend.data.invitations).toBe('contacts');
});

test('conflicting save preserves edited restrictions and reload explicitly replaces the draft', async ({ page }) => {
  const backend = await fixture(page, { servers: { '!server:test': 'contacts' } });
  const choice = page.getByLabel('Invitation restriction for !server:test'); await choice.selectOption('nobody');
  backend.error = 'Another device changed your preferences.';
  await page.getByRole('button', { name: 'Save server invitation preferences', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(backend.error); await expect(choice).toHaveValue('nobody');
  expect(backend.data.servers['!server:test']).toBe('contacts');
  await page.getByRole('button', { name: 'Reload server invitation preferences' }).click(); await expect(choice).toHaveValue('contacts');
});

test('invalid saved rules need explicit replacement and departed-server restrictions can be removed', async ({ page }) => {
  const backend = await fixture(page, { invalid: true, servers: { '!departed:test': 'nobody' } });
  await expect(page.getByRole('alert')).toContainText('new invitations are blocked');
  await page.getByLabel('Invitation restriction for !departed:test').selectOption('inherit');
  await page.getByRole('button', { name: 'Replace invalid server restrictions' }).click();
  await expect(page.getByRole('status')).toContainText('preferences saved'); expect(backend.data.servers).toEqual({});
});

for (const replacement of ['replacePrivacyAccount', 'replacePrivacyActor']) test(`an old response cannot replace preferences after ${replacement}`, async ({ page }) => {
  const backend = await fixture(page, { servers: { '!server:test': 'contacts' } });
  const choice = page.getByLabel('Invitation restriction for !server:test'); await expect(choice).toHaveValue('contacts');
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; }); backend.delay = () => blocked;
  await page.getByRole('button', { name: 'Reload server invitation preferences' }).click(); await expect.poll(() => backend.gets).toBe(2);
  backend.delay = null; backend.data = { ...backend.data, servers: {}, revision: 'c'.repeat(64) };
  await page.evaluate(replacement => (window as any)[replacement](), replacement); await expect(choice).toHaveValue('inherit');
  const completed = page.waitForResponse(response => response.url().includes('/api/social/server-invitation-privacy'));
  release(); await completed;
  await expect(choice).toHaveValue('inherit'); await expect(page.getByRole('alert')).toHaveCount(0); expect(backend.writes).toHaveLength(0);
});
