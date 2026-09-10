import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const names = [...readFileSync('lib/matrix.ts', 'utf8').matchAll(/export (?:async )?function (\w+)/g)].map(match => match[1]);
async function fixture(page: Page, query = '', hash = '') {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: names.map(name => 'export const ' + name + '=(...args)=>window.matrixBoundary(' + JSON.stringify(name) + ',args);').join('\n') }));
  await page.route('**/config.json', route => route.fulfill({ json: { homeserverUrl: 'http://127.0.0.1:5173', serverRolePolicy: true, callsEnabled: false } }));
  await page.route(url => url.pathname === '/app/message-search.tsx', route => route.fulfill({ contentType: 'text/javascript', body: "import React from '/node_modules/.vite/deps/react.js';export const MessageSearch=({onSelect})=>React.createElement('button',{onClick:()=>onSelect(window.historical)},'Open indexed historical message');" }));
  await page.route('**/history-context-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/tests/browser/fixtures/message-history.tsx");</script></body></html>' }));
  await page.goto('/history-context-test?' + query + hash);
  await expect.poll(async () => { if (errors.length) throw new Error(errors.join('\n')); return page.evaluate(() => !!(window as any).ready); }).toBe(true);
  if (query.includes('workspace')) await expect(page.locator('.profile-button')).toContainText('Owner');
  return errors;
}
const context = (page: Page) => page.getByRole('region', { name: 'Message context', exact: true });
const selected = (page: Page) => context(page).getByLabel('Selected message', { exact: true });

test('actual SDK history panel pages empty cursors, joins live history, and supports deliberate retry', async ({ page }) => {
  const errors = await fixture(page);
  await expect(selected(page)).toHaveText('Selected message');
  await expect(context(page)).toContainText('Before the selected message');
  await context(page).getByRole('button', { name: 'Load earlier', exact: true }).click();
  await expect(context(page).getByRole('status')).toContainText('This page added no displayed messages');
  await expect(context(page).getByRole('button', { name: 'Load earlier', exact: true })).toBeEnabled();
  await context(page).getByRole('button', { name: 'Load earlier', exact: true }).click();
  await expect(context(page)).toContainText('Earlier historical message');
  await expect(context(page).getByRole('button', { name: 'Load earlier', exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).historyFixture.state.failPage = true; });
  await context(page).getByRole('button', { name: 'Load later', exact: true }).click();
  await expect(context(page).getByRole('alert')).toContainText('Fixture history denied');
  await page.evaluate(() => { (window as any).historyFixture.state.failPage = false; });
  await context(page).getByRole('button', { name: 'Load later', exact: true }).click();
  await expect(context(page)).toContainText('Later historical message');
  await context(page).getByRole('button', { name: 'Load later', exact: true }).click();
  await expect(context(page)).toContainText('Latest conversation message');
  await expect(context(page).getByRole('button', { name: 'Load later', exact: true })).toBeDisabled();
  await expect(context(page)).toContainText('currently synced conversation');
  expect(await page.evaluate(() => (window as any).historyFixture.requests.length)).toBe(6);
  await context(page).getByRole('button', { name: 'Back to latest', exact: true }).click();
  await expect(context(page)).toHaveCount(0);
  expect(await page.evaluate(() => ({ latest: (window as any).latest, listeners: (window as any).historyFixture.listenerCount() - (window as any).historyListenerBaseline }))).toEqual({ latest: true, listeners: 0 });
  expect(errors).toEqual([]);
});

test('close during native context lookup releases only its listener and cannot publish a late result', async ({ page }) => {
  await fixture(page, 'hold=context');
  await expect.poll(() => page.evaluate(() => (window as any).historyFixture.requests.length)).toBe(1);
  await context(page).getByRole('button', { name: 'Close message context', exact: true }).click();
  await page.evaluate(() => (window as any).release());
  await expect(context(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).historyFixture.listenerCount() - (window as any).historyListenerBaseline)).toBe(0);
  await page.evaluate(() => (window as any).reopen());
  await expect(selected(page)).toHaveText('Selected message');
  expect(await page.evaluate(() => (window as any).historyFixture.listenerCount() - (window as any).historyListenerBaseline)).toBe(1);
});

for (const change of ['account', 'membership']) test(change + ' change clears visible history and rejects delayed decryption', async ({ page }) => {
  await fixture(page);
  await expect(selected(page)).toHaveText('Selected message');
  await page.evaluate(() => { const w = window as any; w.historyFixture.state.decryptGate = new Promise(resolve => { w.release = resolve; }); w.notify(); });
  await expect(context(page).getByRole('status')).toContainText('Updating displayed messages');
  await page.evaluate(change => { const w = window as any; if (change === 'account') w.replaceAccount(); else { w.historyFixture.room.updateMyMembership('leave'); w.notify(); } }, change);
  await expect(context(page).getByRole('alert')).toContainText('account or conversation access changed');
  await expect(selected(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).release());
  await expect(selected(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).historyFixture.listenerCount() - (window as any).historyListenerBaseline)).toBe(0);
});

test('missing keys and StrictMode replay remain honest and keyboard controls work on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 }); await fixture(page, 'missing-key&strict');
  await expect(selected(page)).toHaveText('Missing key');
  await expect(context(page)).toContainText('does not replace missing encryption keys');
  expect(await page.evaluate(() => (window as any).historyFixture.listenerCount() - (window as any).historyListenerBaseline)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const close = context(page).getByRole('button', { name: 'Close message context', exact: true });
  await close.focus(); await page.keyboard.press('Enter'); await expect(context(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).historyFixture.listenerCount() - (window as any).historyListenerBaseline)).toBe(0);
});

test('saved historical messages open context rather than losing their selected event at latest', async ({ page }) => {
  await fixture(page, 'workspace');
  await page.getByRole('button', { name: 'Saved for later', exact: true }).click();
  await expect(page.getByText('Historical bookmarked message', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '#Source', exact: true }).click();
  await expect(selected(page)).toContainText('Historical bookmarked message');
  expect(await page.evaluate(() => (window as any).historyCalls.filter((call: any[]) => call[0] === 'open'))).toEqual([['open', '!source:local', '$historical']]);
  await context(page).getByRole('button', { name: 'Back to latest', exact: true }).click();
  await expect(context(page)).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Source', exact: true, level: 1 })).toBeVisible();
});

test('search and deep links open history while real thread replies and private rooms retain their own panels', async ({ page }) => {
  await fixture(page, 'workspace');
  await page.getByRole('button', { name: 'Search conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Open indexed historical message', exact: true }).click();
  await expect(selected(page)).toContainText('Historical bookmarked message');
  await page.evaluate(() => { location.hash = 'room=%21source%3Alocal&event=%24thread-reply'; });
  await expect(context(page)).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Thread #Source', exact: true })).toBeVisible();
  await page.evaluate(() => { location.hash = 'room=%21source%3Alocal&event=%24historical'; });
  await expect(selected(page)).toContainText('Historical bookmarked message');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.evaluate(() => { location.hash = 'room=%21private%3Alocal&event=%24private'; });
  await expect(context(page)).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Private discussion', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

test('history gallery uses its own messages and revokes displayed media when its owning context is lost', async ({ page }) => {
  await fixture(page, 'workspace', '#room=%21source%3Alocal&event=%24historical');
  await expect(selected(page)).toContainText('Historical bookmarked message');
  await selected(page).getByRole('button', { name: /history\.png/ }).click();
  await expect(page.getByRole('dialog', { name: 'history.png', exact: true }).getByRole('img', { name: 'history.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next attachment', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'neighbour.png', exact: true }).getByRole('img', { name: 'neighbour.png', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).historyCalls.filter((call: any[]) => call[0] === 'media').map((call: any[]) => call[1]))).toEqual(['history-image', 'neighbour-image']);
  await page.evaluate(() => (window as any).replaceAccount());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => { const w = window as any; return w.urls.length === w.revoked.length; })).toBe(true);
});
