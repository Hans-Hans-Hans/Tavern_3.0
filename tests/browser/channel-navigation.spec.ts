import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page) {
  page.on('pageerror', error => console.error(error.message));
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const accountArtworkOwner=()=>window.account;export const isManagedAccount=()=>true;export const requestApi=async()=>{throw Error('Unexpected API request')};` }));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const getMatrixClient=()=>window.client;export const onMatrixUpdate=f=>{window.listeners.add(f);return()=>window.listeners.delete(f)};export const markMatrixRoomsRead=async ids=>window.marked=ids;export const mutateMatrixAccountData=async(c,type,mutate,check)=>{check();const v=await c.getAccountDataFromServer(type);check();await c.setAccountData(type,mutate(v));check();};` }));
  await page.route(url => url.pathname === '/lib/notifications.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const setRoomNotifications=async(c,id,mode,active)=>{if(!active())throw Error('Stale owner');(window.notifications??=[]).push([id,mode]);};` }));
  await page.route('**/channel-navigation-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id='root'></div><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/channel-navigation.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/channel-navigation-test'); await expect(page.getByRole('button', { name: 'General', exact: true })).toBeVisible();
}
const channel = (page: Page, id: string) => page.locator(`[data-channel-id="!${id}:local"] .channel-navigation-row`);
const category = (page: Page, id: string) => page.locator(`[data-category-id="${id}"]`);
async function moveDialog(page: Page, name: string) { await page.getByRole('button', { name: 'Channel actions for ' + name }).click(); await page.getByRole('menuitem', { name: 'Move channel', exact: true }).click(); }
async function drag(page: Page, from: ReturnType<typeof channel>, to: ReturnType<typeof channel>, edge: 'before' | 'after' = 'after') {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await from.dispatchEvent('dragstart', { dataTransfer });
  const box = (await to.boundingBox())!; const clientY = box.y + (edge === 'before' ? 2 : box.height - 2);
  await to.dispatchEvent('dragover', { dataTransfer, clientY });
  await expect(to).toHaveAttribute('data-drop', edge);
  await to.dispatchEvent('drop', { dataTransfer, clientY });
}

test('keyboard Move chooses exact category/position and persists native layout order after reload', async ({ page }) => {
  await setup(page); await moveDialog(page, 'Lounge');
  await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('chat'); await page.getByRole('combobox', { name: 'Position', exact: true }).selectOption('!rules:local');
  await page.getByRole('button', { name: 'Save position' }).press('Enter'); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).saves[0].value['io.tavern.previous_event'])).toBe('$layout:0');
  expect(await page.locator('.channel-category').filter({ has: category(page, 'chat') }).locator('[data-channel-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-channel-id')))).toEqual(['!general:local', '!voice:local', '!rules:local']);
  await page.reload(); await expect(channel(page, 'voice')).toBeVisible();
  expect(await page.locator('.channel-category').filter({ has: category(page, 'chat') }).locator('[data-channel-id]').count()).toBe(3);
});

test('full-row drag supports before/after, category order, root moves and suppresses navigation clicks', async ({ page }) => {
  await setup(page); await drag(page, channel(page, 'rules'), channel(page, 'general'), 'before');
  await page.getByRole('button', { name: 'Rules', exact: true }).dispatchEvent('click'); expect(await page.evaluate(() => (window as any).selected)).toEqual([]);
  await expect.poll(() => page.evaluate(() => (window as any).saves.length)).toBe(1);
  await drag(page, channel(page, 'general'), channel(page, 'root'), 'after');
  await expect.poll(() => page.evaluate(() => (window as any).layout.channels.find((c: any) => c.id === '!general:local').category)).toBe('');
  await drag(page, category(page, 'games'), category(page, 'chat'), 'before');
  expect(await page.evaluate(() => (window as any).layout.categories.map((c: any) => c.id))).toEqual(['games', 'chat']);
});

test('category create, rename and deletion keep channels; callbacks and actual kind icons stay available', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: 'Create category', exact: true }).click(); await page.getByLabel('Category name').fill('Projects'); await page.getByRole('button', { name: 'Save category' }).click();
  await page.getByRole('button', { name: 'Category actions for Projects' }).click(); await page.getByRole('menuitem', { name: 'Edit category', exact: true }).click(); await page.getByLabel('Category name').fill('Work'); await page.getByRole('button', { name: 'Save category' }).click();
  await page.getByRole('button', { name: 'Create channel in Work' }).click(); await page.getByRole('button', { name: 'Edit General', exact: true }).click(); await page.getByRole('button', { name: 'Invite to General', exact: true }).click();
  expect(await page.evaluate(() => (window as any).callbacks.map((v: any) => v[0]))).toEqual(['create', 'edit', 'invite']);
  await page.getByRole('button', { name: 'Category actions for Chat' }).click(); await page.getByRole('menuitem', { name: 'Delete category', exact: true }).click(); await page.getByRole('button', { name: 'Delete category and keep channels' }).click();
  await expect(category(page, 'chat')).toHaveCount(0); expect(await page.evaluate(() => (window as any).layout.channels.length)).toBe(5);
  await expect(page.locator('[data-channel-id="!voice:local"]')).toHaveAttribute('data-channel-kind', 'voice'); await expect(channel(page, 'voice').locator('.lucide-volume2')).toHaveCount(1); await expect(channel(page, 'rules').locator('.lucide-book-open')).toHaveCount(1); await expect(page.getByTestId('voice-participants')).toHaveCount(1);
});

test('collapse shows aggregate unmuted badges, personal category notifications remain accessible without edit authority', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(channel(page, 'general')).toHaveCount(0); await expect(category(page, 'chat').getByRole('img', { name: '3 unread notifications' })).toBeVisible(); await expect(category(page, 'chat').getByRole('img', { name: '2 unread mentions and highlights' })).toBeVisible();
  await page.evaluate(() => { (window as any).allowed = false; (window as any).emit(); }); await expect(page.getByRole('button', { name: 'Create category', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Category actions for Chat' }).click(); await page.getByRole('menuitem', { name: 'Mute category notifications' }).click();
  expect(await page.evaluate(() => (window as any).notifications)).toEqual([['!general:local', 'mute'], ['!rules:local', 'mute']]);
});

test('save rejection rolls back optimistic order and keeps the user draft available', async ({ page }) => {
  await setup(page); await page.evaluate(() => { (window as any).failSave = true; (window as any).holdSave = true; });
  await moveDialog(page, 'Lounge'); await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('chat'); await page.getByRole('button', { name: 'Save position' }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).releaseSave)).toBe(true);
  await expect(page.locator('.channel-category').filter({ has: category(page, 'chat') }).locator('[data-channel-id="!voice:local"]')).toHaveCount(1);
  await page.evaluate(() => (window as any).releaseSave()); await expect(page.getByRole('alert')).toHaveText('Fixture server rejected this layout.');
  await expect(page.locator('.channel-category').filter({ has: category(page, 'games') }).locator('[data-channel-id="!voice:local"]')).toHaveCount(1); await expect(page.getByRole('combobox', { name: 'Category', exact: true })).toHaveValue('chat');
});

test('unrelated updates and new channel-array references preserve an open draft; concurrent layout retires drag', async ({ page }) => {
  await setup(page); await moveDialog(page, 'Lounge'); await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('chat');
  await page.evaluate(() => { for (let i = 0; i < 10; i++) { (window as any).emit(); (window as any).redraw(); } }); await expect(page.getByRole('combobox', { name: 'Category', exact: true })).toHaveValue('chat');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer()); await channel(page, 'general').dispatchEvent('dragstart', { dataTransfer });
  await page.evaluate(() => { const w = window as any; w.layout.categories[0].name = 'Changed'; w.revision = '$external'; w.emit(); });
  await channel(page, 'voice').dispatchEvent('drop', { dataTransfer }); expect(await page.evaluate(() => (window as any).saves.length)).toBe(0); await expect(page.getByRole('button', { name: 'Changed', exact: true })).toBeVisible();
});

test('A to B to A generation change during native state read sends nothing and does not revive the old dialog', async ({ page }) => {
  await setup(page); await moveDialog(page, 'Lounge'); await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('chat'); await page.evaluate(() => { (window as any).holdRead = true; }); await page.getByRole('button', { name: 'Save position' }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).releaseRead)).toBe(true);
  await page.evaluate(() => { const w = window as any; w.account = 'B:2'; w.actor = '@other:local'; w.emit(); }); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => { const w = window as any; w.account = 'A:3'; w.actor = '@owner:local'; w.emit(); w.releaseRead(); }); await expect(page.getByRole('button', { name: 'Create category', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create category', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); expect(await page.evaluate(() => (window as any).saves.length)).toBe(0);
});

test('hovering a collapsed category exposes a destination, and a stale permission cannot commit a drop', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: 'Games', exact: true }).click(); await expect(channel(page, 'voice')).toHaveCount(0);
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer()); await channel(page, 'general').dispatchEvent('dragstart', { dataTransfer });
  await category(page, 'games').dispatchEvent('dragover', { dataTransfer }); await expect(category(page, 'games')).toHaveAttribute('data-drop', 'inside'); await expect(channel(page, 'voice')).toBeVisible();
  await page.evaluate(() => { (window as any).allowed = false; (window as any).emit(); }); await category(page, 'games').dispatchEvent('drop', { dataTransfer });
  expect(await page.evaluate(() => (window as any).saves.length)).toBe(0); await expect(channel(page, 'voice')).toHaveCount(0);
});

test('header category requests open the same dialog once and do not reopen for a replacement account', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { const w = window as any; w.categoryRequest = 1; w.redraw(); }); await expect(page.getByRole('dialog', { name: 'Create category' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { const w = window as any; w.account = 'B:2'; w.actor = '@other:local'; w.emit(); }); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => { const w = window as any; w.categoryRequest = 2; w.redraw(); }); await expect(page.getByRole('dialog', { name: 'Create category' })).toBeVisible();
});

test('a failed old-server save cannot publish its error in the replacement server view', async ({ page }) => {
  await setup(page); await page.evaluate(() => { const w = window as any; w.holdSave = true; w.failSave = true; });
  await moveDialog(page, 'Lounge'); await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('chat'); await page.getByRole('button', { name: 'Save position' }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).releaseSave)).toBe(true);
  await page.evaluate(() => { const w = window as any; const original = w.rooms.get('!server:local'); w.rooms.set('!second:local', { ...original, roomId: '!second:local' }); w.serverId = '!second:local'; w.redraw(); });
  await expect(page.getByRole('dialog')).toHaveCount(0); await page.getByRole('button', { name: 'Create category', exact: true }).click();
  await page.evaluate(async () => { (window as any).releaseSave(); await new Promise(resolve => setTimeout(resolve, 0)); });
  await expect(page.getByRole('dialog', { name: 'Create category' })).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.locator('.channel-navigation-error')).toHaveCount(0);
});

test('touch viewport exposes Move actions without hover and the dialog stays within the viewport', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, baseURL: 'http://127.0.0.1:5173' });
  const page = await context.newPage();
  try {
    await setup(page); const button = page.getByRole('button', { name: 'Channel actions for Lounge' });
    expect(await button.evaluate(node => getComputedStyle(node.parentElement!).opacity)).toBe('1');
    await button.tap(); await page.getByRole('menuitem', { name: 'Move channel', exact: true }).tap();
    const bounds = (await page.getByRole('dialog').boundingBox())!; expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption(''); await page.getByRole('button', { name: 'Save position' }).tap(); await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).layout.channels.find((c: any) => c.id === '!voice:local').category)).toBe('');
  } finally { await context.close(); }
});

test('leaving the sidebar clears drag effects while internal movement and re-entry retain the drag', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: 'Games', exact: true }).click();
  await page.evaluate(() => { const box = document.querySelector<HTMLElement>('.channel-sidebar')!; box.style.height = '210px'; const filler = document.createElement('div'); filler.style.height = '1000px'; box.appendChild(filler); });
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await channel(page, 'general').dispatchEvent('dragstart', { dataTransfer });
  const bounds = (await page.locator('.channel-sidebar').boundingBox())!;
  await category(page, 'games').dispatchEvent('dragover', { dataTransfer, clientY: bounds.y + bounds.height - 2 });
  await category(page, 'games').evaluate(node => node.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: node.querySelector('button') })));
  await expect(category(page, 'games')).toHaveAttribute('data-drop', 'inside');
  await page.locator('nav.channel-navigation').dispatchEvent('dragleave', { dataTransfer, relatedTarget: null });
  const stopped = await page.locator('.channel-sidebar').evaluate(node => node.scrollTop);
  await expect(category(page, 'games')).not.toHaveAttribute('data-drop');
  // The actual 550ms expansion and animation loop must stay cancelled after exit.
  await page.waitForTimeout(700);
  expect(await page.locator('.channel-sidebar').evaluate(node => node.scrollTop)).toBe(stopped);
  await expect(category(page, 'games').getByRole('button', { name: 'Games', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await category(page, 'games').dispatchEvent('dragover', { dataTransfer, clientY: bounds.y + 80 });
  await expect(category(page, 'games')).toHaveAttribute('data-drop', 'inside');
  await expect(channel(page, 'voice')).toBeVisible();
  await category(page, 'games').dispatchEvent('drop', { dataTransfer, clientY: bounds.y + 80 });
  await expect.poll(() => page.evaluate(() => (window as any).layout.channels.find((c: any) => c.id === '!general:local').category)).toBe('games');
  expect(await page.evaluate(() => (window as any).saves.length)).toBe(1);
});
