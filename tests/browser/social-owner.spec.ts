import { expect, test, type Page } from '@playwright/test';

const contact = (peer: string) => ({ requests: [{ id: 'request-' + peer, sender: '@owner:local', target: peer, status: 'accepted', created: 1, updated: 1 }], blocked: [], privacy: 'everyone', hasMore: false });
async function fixture(page: Page) {
  const backend = { reads: [] as string[], writes: [] as any[], data: contact('@old-contact:local'), beforeRead: null as null | ((snapshot: any) => Promise<void>), beforeWrite: null as null | (() => Promise<void>), reject: false };
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const getMatrixClient=()=>window.socialOwner?.client;export const onMatrixUpdate=fn=>{window.socialOwner.listeners.add(fn);return()=>window.socialOwner.listeners.delete(fn)};' }));
  await page.route(url => url.pathname === '/app/community-settings.tsx', route => route.fulfill({ contentType: 'application/javascript', body: "import React from '/node_modules/.vite/deps/react.js';export const CommunityImage=({name})=>React.createElement('span',{'aria-hidden':true},name.slice(0,1));" }));
  await page.route('**/api/social/events', route => route.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route(url => url.pathname === '/api/social' || url.pathname.startsWith('/api/social/') && url.pathname !== '/api/social/events', async route => {
    const request = route.request(), device = request.headers()['x-tavern-device'] || '';
    if (request.method() === 'GET') { const snapshot = structuredClone(backend.data); backend.reads.push(device); await backend.beforeRead?.(snapshot); return route.fulfill({ json: snapshot }); }
    const snapshot = structuredClone(backend.data); backend.writes.push({ device, path: new URL(request.url()).pathname, method: request.method(), body: request.postData() ? request.postDataJSON() : undefined }); await backend.beforeWrite?.();
    return route.fulfill(backend.reject ? { status: 503, json: { error: 'Contacts service is temporarily unavailable.' } } : { json: snapshot });
  });
  await page.route('**/social-owner-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/social-owner.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/social-owner-test'); await expect(page.getByRole('button', { name: 'Block', exact: true })).toBeVisible(); return backend;
}

test('an open old-owner confirmation is removed after an API A to B to A generation change', async ({ page }) => {
  const backend = await fixture(page); await page.getByRole('button', { name: 'Block', exact: true }).click(); await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.evaluate(() => { const f = (window as any).socialOwner; f.switchDevice('B', false); f.switchDevice('A'); });
  await expect(page.getByRole('alertdialog')).toHaveCount(0); expect(backend.writes).toEqual([]);
});

test('stale confirmation cannot issue a write if the device changes before the next Matrix render', async ({ page }) => {
  const backend = await fixture(page); await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.evaluate(() => { (window as any).socialOwner.switchDevice('B', false); }); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  expect(backend.writes).toEqual([]);
});

test('a late old account read cannot restore its contacts, search or request draft after replacement', async ({ page }) => {
  const backend = await fixture(page); await page.getByLabel('Add a contact').fill('@old-draft:local'); await page.getByLabel('Find a contact').fill('Old');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); backend.beforeRead = async () => { backend.beforeRead = null; await gate; };
  await page.getByRole('button', { name: 'Refresh contacts' }).click(); await expect.poll(() => backend.reads.length).toBe(2);
  backend.data = contact('@new-contact:local'); await page.evaluate(() => (window as any).socialOwner.switchDevice('B'));
  await expect(page.getByText('@new-contact:local', { exact: true })).toBeVisible(); await expect(page.getByLabel('Add a contact')).toHaveValue(''); await expect(page.getByLabel('Find a contact')).toHaveValue('');
  release(); await expect(page.getByText('@old-contact:local', { exact: true })).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a late write completion cannot clear the replacement account draft or show its old response', async ({ page }) => {
  const backend = await fixture(page); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); backend.beforeWrite = async () => { backend.beforeWrite = null; await gate; };
  await page.getByLabel('Add a contact').fill('@old-draft:local'); await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect.poll(() => backend.writes.length).toBe(1);
  backend.data = contact('@new-contact:local'); await page.evaluate(() => (window as any).socialOwner.switchDevice('B')); await expect(page.getByText('@new-contact:local', { exact: true })).toBeVisible();
  await page.getByLabel('Add a contact').fill('@new-draft:local'); release(); await expect(page.getByLabel('Add a contact')).toHaveValue('@new-draft:local'); await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.getByLabel('Add a contact')).toHaveValue('');
  expect(backend.writes.map(write => [write.device, write.body.target])).toEqual([['A', '@old-draft:local'], ['B', '@new-draft:local']]); await expect(page.getByText('@old-contact:local', { exact: true })).toHaveCount(0);
});

test('an earlier refresh cannot undo a confirmed contact removal in the same account', async ({ page }) => {
  const backend = await fixture(page); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); backend.beforeRead = async () => { backend.beforeRead = null; await gate; };
  await page.getByRole('button', { name: 'Refresh contacts' }).click(); await expect.poll(() => backend.reads.length).toBe(2);
  backend.data = { ...backend.data, requests: [] }; await page.getByRole('button', { name: 'Remove', exact: true }).click(); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0); await expect(page.getByText('@old-contact:local', { exact: true })).toHaveCount(0); release();
  await expect(page.getByText(/Send a request to add your first contact/)).toBeVisible(); await expect(page.getByText('@old-contact:local', { exact: true })).toHaveCount(0);
});

test('service rejection preserves the current request draft and supports an explicit retry', async ({ page }) => {
  const backend = await fixture(page); backend.reject = true; await page.getByLabel('Add a contact').fill('@friend:local'); await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Contacts service is temporarily unavailable.'); await expect(page.getByLabel('Add a contact')).toHaveValue('@friend:local');
  backend.reject = false; await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.getByLabel('Add a contact')).toHaveValue(''); await expect(page.getByRole('alert')).toHaveCount(0); expect(backend.writes).toHaveLength(2);
});
