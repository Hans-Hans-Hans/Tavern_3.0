import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.emojiManagerFixture?.client;export const onMatrixUpdate=fn=>{window.emojiManagerFixture.listeners.add(fn);return()=>window.emojiManagerFixture.listeners.delete(fn)};export const matrixApi=async()=>({});export const mutateMatrixAccountData=()=>{throw Error("Unexpected account data write")};' }));
  await page.route(url => url.pathname === '/app/community-settings.tsx', route => route.fulfill({ contentType: 'text/javascript', body: 'export const CommunityImage=props=>window.emojiManagerFixture.image(props);' }));
  await page.route('**/test-emoji-image', route => route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64') }));
  await page.route('**/emoji-manager-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/server-emoji.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/emoji-manager-test');
  await expect(page.getByRole('heading', { name: 'Server emoji', exact: true })).toBeVisible();
}
async function imageFile(page: Page) {
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 80; const context = canvas.getContext('2d')!; context.fillStyle = '#52b788'; context.fillRect(0, 0, 80, 80); return canvas.toDataURL().split(',')[1]; });
  await page.getByLabel('Emoji image', { exact: true }).setInputFiles({ name: 'garden.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.getByRole('img', { name: 'Emoji upload preview' })).toBeVisible();
}

test('emoji manager previews uploads, retains rejected drafts, finds aliases and confirms removal', async ({ page }) => {
  await fixture(page); await imageFile(page);
  await expect(page.getByLabel('Emoji name', { exact: true })).toHaveValue('garden');
  await page.evaluate(() => { (window as any).emojiManagerFixture.reject = true; });
  await page.getByRole('button', { name: 'Upload emoji', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Server rejected');
  await expect(page.getByRole('img', { name: 'Emoji upload preview' })).toBeVisible();
  await expect(page.getByLabel('Emoji name', { exact: true })).toHaveValue('garden');
  await page.evaluate(() => { (window as any).emojiManagerFixture.reject = false; });
  await page.getByRole('button', { name: 'Upload emoji', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rename garden', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Emoji upload preview' })).toHaveCount(0);
  expect(await page.getByLabel('Emoji image', { exact: true }).evaluate((input: HTMLInputElement) => input.files?.length)).toBe(0);
  await page.getByRole('searchbox', { name: 'Search managed emoji' }).fill(':celebrate:');
  await expect(page.getByRole('button', { name: 'Rename cheers', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename garden', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Rename cheers', exact: true }).click();
  await page.getByLabel('New emoji name').fill('party'); await page.getByRole('button', { name: 'Save emoji name' }).click();
  await expect(page.getByRole('button', { name: 'Remove party', exact: true })).toBeVisible();
  await expect(page.locator('.server-emoji-row-name')).toContainText('Also works: :cheers: :celebrate:');
  await page.getByRole('button', { name: 'Remove party', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => (window as any).emojiManagerFixture.emoji.length)).toBe(2);
  await page.getByRole('button', { name: 'Remove party', exact: true }).click();
  await page.getByRole('button', { name: 'Remove emoji', exact: true }).click();
  await expect(page.locator('.server-emoji-empty')).toContainText('No emoji match');
  expect(await page.evaluate(() => (window as any).emojiManagerFixture.emoji.map((emoji: any) => emoji.name))).toEqual(['garden']);
});

test('a replaced emoji is not removed by an old confirmation dialog', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Remove cheers', exact: true }).click();
  await page.evaluate(() => { const f = (window as any).emojiManagerFixture; f.emoji = [{ ...f.emoji[0], uri: 'mxc://local/replacement' }]; f.notify(); });
  await page.getByRole('button', { name: 'Remove emoji', exact: true }).click();
  await expect(page.getByRole('alertdialog').getByRole('alert')).toContainText('changed or was removed');
  expect(await page.evaluate(() => (window as any).emojiManagerFixture.writes.length)).toBe(0);
});

test('closing the editor during upload stops the pending emoji state write', async ({ page }) => {
  await fixture(page); await imageFile(page);
  await page.evaluate(() => { (window as any).emojiManagerFixture.delayUpload = true; });
  await page.getByRole('button', { name: 'Upload emoji', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).emojiManagerFixture.releaseUpload)).toBe(true);
  await page.evaluate(() => { const f = (window as any).emojiManagerFixture; f.unmount(); f.releaseUpload(); });
  await expect(page.locator('.server-emoji-manager')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).emojiManagerFixture.writes.length)).toBe(0);
});

for (const width of [320, 375, 1280]) test('emoji management fits at ' + width + 'px in both themes', async ({ page }) => {
  await page.setViewportSize({ width, height: 850 }); await fixture(page); await imageFile(page);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const button = await page.getByRole('button', { name: 'Rename cheers', exact: true }).boundingBox();
    expect(button?.height).toBeGreaterThanOrEqual(44);
    const textColor = await page.locator('.server-emoji-row-name strong').evaluate(element => getComputedStyle(element).color);
    await expect(page.getByRole('button', { name: 'Rename cheers', exact: true })).toHaveCSS('color', textColor);
    await page.screenshot({ path: 'work/emoji-' + width + '-' + theme + '.png', fullPage: true });
  }
});
