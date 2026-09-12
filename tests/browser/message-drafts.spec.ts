import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const names = [...readFileSync('lib/matrix.ts', 'utf8').matchAll(/export (?:async )?function (\w+)/g)].map(match => match[1]);
async function fixture(page: Page, forum = false) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: names.map(name => 'export const ' + name + '=(...args)=>window.matrixBoundary(' + JSON.stringify(name) + ',args);').join('\n') }));
  await page.route('**/config.json', route => route.fulfill({ json: { homeserverUrl: 'http://127.0.0.1:5173', serverRolePolicy: true, callsEnabled: false } }));
  await page.route('**/message-drafts-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/message-drafts.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/message-drafts-test' + (forum ? '?forum' : ''));
  if (forum) await expect(page.getByRole('button', { name: 'Draft forum topic', exact: true })).toBeVisible();
  else await expect(page.getByRole('textbox', { name: 'Message Source', exact: true })).toBeEnabled();
}
const source = (page: Page) => page.getByRole('textbox', { name: 'Message Source', exact: true });
const dm = (page: Page) => page.getByRole('textbox', { name: 'Message Guest', exact: true });
const selectDm = async (page: Page) => { await page.getByRole('button',{name:'Direct messages',exact:true}).click(); await page.locator('.dm-section .dm-link').filter({ hasText: 'Guest' }).click(); };
const selectSource = async (page: Page) => { await page.getByRole('button',{name:'All channels',exact:true}).click(); await page.locator('.channel-nav-row button').filter({ hasText: 'Source' }).click(); };
const sheet = (page: Page) => page.locator('.thread-sheet');

test('channel, DM and duplicate favorite indicators update immediately and drafts survive navigation', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await fixture(page);
  await source(page).fill('Source draft');
  await expect(page.getByLabel('Draft in Source', { exact: true })).toHaveCount(2);
  await selectDm(page); await expect(dm(page)).toHaveValue('');
  await dm(page).fill('DM draft');
  await expect(page.getByLabel('Draft in Guest', { exact: true })).toHaveCount(2);
  expect(await page.getByLabel('Draft in Guest', { exact: true }).evaluateAll(badges => badges.every(badge => {
    const a = badge.getBoundingClientRect(), b = badge.closest('button')!.getBoundingClientRect();
    return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
  }))).toBe(true);
  await selectSource(page); await expect(source(page)).toHaveValue('Source draft');
  await source(page).fill('   '); await expect(page.getByLabel('Draft in Source', { exact: true })).toHaveCount(0);
  await selectDm(page); await expect(dm(page)).toHaveValue('DM draft');
  await selectSource(page); await expect(source(page)).toHaveValue('   ');
  expect(errors).toEqual([]);
});

test('a first unsent thread reply stays discoverable and acknowledgement clears only that reply', async ({ page }) => {
  await fixture(page); await source(page).fill('Main draft remains');
  await page.locator('.message').first().hover();
  await page.getByRole('button', { name: 'Reply in thread', exact: true }).first().press('Enter');
  const reply = sheet(page).getByRole('textbox', { name: 'Message this thread', exact: true });
  await reply.fill('Thread draft');
  await expect(sheet(page).getByLabel('Draft reply in Source', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'View thread Draft reply', exact: true }).click();
  await expect(reply).toHaveValue('Thread draft');
  await sheet(page).getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(reply).toHaveValue(''); await expect(sheet(page).getByLabel('Draft reply in Source')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(source(page)).toHaveValue('Main draft remains');
  await expect(page.getByLabel('Draft in Source', { exact: true })).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).sent[0].parent)).toBe('$source');
});

test('a failed send preserves the draft and badges until an acknowledged retry', async ({ page }) => {
  await fixture(page); await selectDm(page); await dm(page).fill('Keep until acknowledged');
  await page.evaluate(() => { (window as any).rejectSend = true; });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Message was not confirmed. Your draft is kept.')).toBeVisible();
  await expect(dm(page)).toHaveValue('Keep until acknowledged');
  await expect(page.getByLabel('Draft in Guest', { exact: true })).toHaveCount(2);
  await page.evaluate(() => { (window as any).rejectSend = false; });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(dm(page)).toHaveValue(''); await expect(page.getByLabel('Draft in Guest', { exact: true })).toHaveCount(0);
});

test('late acknowledgement from an unmounted composer preserves a newer same-room draft', async ({ page }) => {
  await fixture(page); await source(page).fill('Older sending draft');
  await page.evaluate(() => { (window as any).deferSend = true; });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).pendingSends.length)).toBe(1);
  await selectDm(page); await selectSource(page); await source(page).fill('Newer draft');
  await page.evaluate(() => (window as any).pendingSends[0].resolve());
  await expect(source(page)).toHaveValue('Newer draft'); await expect(page.getByLabel('Draft in Source', { exact: true })).toHaveCount(2);
});

test('API generation A to B to A clears old text and a late send cannot clear the new owner draft', async ({ page }) => {
  await fixture(page); await source(page).fill('Old private draft');
  await page.evaluate(() => { (window as any).deferSend = true; });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).pendingSends.length)).toBe(1);
  await page.evaluate(() => (window as any).replaceAccount());
  await expect(source(page)).toHaveValue(''); await expect(source(page)).toBeEnabled();
  await expect(page.getByLabel('Draft in Source', { exact: true })).toHaveCount(0);
  await source(page).fill('New owner draft'); await page.evaluate(() => (window as any).pendingSends[0].resolve());
  await expect(source(page)).toHaveValue('New owner draft'); await expect(page.getByLabel('Draft in Source', { exact: true })).toHaveCount(2);
});

test('forum cards keep an unsent reply visible after closing its actual thread composer', async ({ page }) => {
  await fixture(page, true);
  await page.getByRole('button', { name: 'Draft forum topic', exact: true }).click();
  const reply = sheet(page).getByRole('textbox', { name: 'Message this thread', exact: true });
  await reply.fill('Forum reply draft'); await page.keyboard.press('Escape');
  await expect(page.locator('.forum-post').getByLabel('Draft reply to Draft forum topic', { exact: true })).toBeVisible();
  expect(await page.locator('.forum-post .message-draft-badge').evaluate(badge => {
    const a = badge.getBoundingClientRect(), b = badge.closest('.forum-post')!.getBoundingClientRect();
    return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
  })).toBe(true);
  await page.getByRole('button', { name: 'Draft forum topic', exact: true }).click();
  await expect(reply).toHaveValue('Forum reply draft');
  await reply.fill(''); await page.keyboard.press('Escape');
  await expect(page.locator('.forum-post').getByLabel('Draft reply to Draft forum topic', { exact: true })).toHaveCount(0);
});

test('DMs have a dedicated rail section and do not share channel favorites', async ({page}) => {
  await fixture(page);
  await expect(page.locator('.dm-section')).toHaveCount(0);
  await selectDm(page);
  await expect(page.getByRole('button',{name:'Direct messages',exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.locator('.workspace-select strong')).toHaveText('Direct messages');
  await expect(page.locator('.channel-nav-row')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Create a Channel',exact:true})).toHaveCount(0);
  await expect(page).toHaveURL(/#room=/);
  await selectSource(page);
  await expect(page.locator('.dm-section')).toHaveCount(0);
});
