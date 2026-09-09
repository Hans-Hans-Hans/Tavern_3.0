import { test, expect, type Page, type Locator } from '@playwright/test';

async function fixture(page: Page) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    const records={};export const onMatrixUpdate=()=>()=>{};
    const client={getAccountData:key=>records[key]?{getContent:()=>records[key]}:undefined,
      getAccountDataFromServer:async key=>records[key],setAccountData:async(key,value)=>{records[key]=value;}};export const getMatrixClient=()=>client;` }));
  await page.route('**/modal-layout-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name='viewport' content='width=device-width, initial-scale=1'></head><body><div id='root'></div><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/modal-layout.tsx')).mountFixture();</script></body></html>` }));
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/modal-layout-test');
}
async function fits(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible();
  const metrics = await dialog.evaluate(element => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width,
      client: element.clientWidth, scroll: element.scrollWidth, overflow: style.overflowX,
      overflowing: [...element.querySelectorAll<HTMLElement>('button,input,select,textarea,[role=tablist],[role=tabpanel]')]
        .filter(control => control.getClientRects().length).filter(control => {
          const rect = control.getBoundingClientRect(); return rect.left < box.left - 1 || rect.right > box.right + 1 || control.scrollWidth > control.clientWidth + 1;
        }).map(control => control.getAttribute('aria-label') || control.textContent || control.tagName) };
  });
  const viewport = page.viewportSize()!;
  expect(metrics.x).toBeGreaterThanOrEqual(15); expect(metrics.y).toBeGreaterThanOrEqual(15);
  expect(metrics.right).toBeLessThanOrEqual(viewport.width - 15); expect(metrics.bottom).toBeLessThanOrEqual(viewport.height - 15);
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1); expect(metrics.overflow).not.toBe('hidden');
  expect(metrics.overflowing).toEqual([]);
}

for (const [width, height] of [[320, 568], [390, 480], [650, 360], [1280, 360]]) {
  test(`real appearance settings fit and remain operable at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await fixture(page);
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Tavern settings' }); await fits(page, dialog);
    const tabRows = await dialog.getByRole('tab').evaluateAll(tabs => new Set(tabs.map(tab => Math.round(tab.getBoundingClientRect().top))).size);
    expect(tabRows).toBeGreaterThan(1);
    await dialog.getByRole('button', { name: 'After hours', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await dialog.getByRole('combobox', { name: 'Font', exact: true }).selectOption('monospace');
    await expect(page.locator('html')).toHaveAttribute('data-tavern-font', 'monospace');
    await dialog.getByRole('slider', { name: 'Chat text size', exact: true }).focus(); await page.keyboard.press('End');
    await expect(page.locator('html')).toHaveCSS('--tavern-chat-scale', '1.5');
    await dialog.getByRole('button', { name: 'Dusk violet', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Dusk violet', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('switch', { name: 'Compact messages', exact: true }).click();
    await expect(dialog.getByRole('switch', { name: 'Compact messages', exact: true })).toHaveAttribute('aria-checked', 'true');
    await fits(page, dialog);
    await dialog.getByRole('tab', { name: 'Appearance', exact: true }).focus(); await page.keyboard.press('End');
    await expect(dialog.getByRole('tab', { name: 'About', exact: true })).toBeFocused();
    await expect(dialog.getByRole('tabpanel')).toHaveText('About preferences');
    await fits(page, dialog);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeFocused();
  });
  test(`confirmation text and both actions fit at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await fixture(page);
    await page.getByRole('button', { name: 'Open confirmation', exact: true }).click();
    const dialog = page.getByRole('alertdialog'); await fits(page, dialog);
    await dialog.getByRole('button', { name: 'Keep my current configuration', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Open confirmation', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm these configuration changes', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('Configuration confirmed.');
  });
}

test('an open settings modal adapts to short landscape and resized windows without losing controls or tab focus', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 }); await fixture(page);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Tavern settings' });
  for (const width of [320, 390, 650, 1280]) {
    await page.setViewportSize({ width, height: 240 }); await fits(page, dialog);
    const compact = dialog.getByRole('switch', { name: 'Compact messages', exact: true });
    await compact.click();
    await expect(compact).toBeInViewport();
    const scrolling = await dialog.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, full: element.scrollHeight }));
    expect(scrolling.top).toBeGreaterThan(0); expect(scrolling.full).toBeGreaterThan(scrolling.height);
    await dialog.getByRole('tab', { name: 'Appearance', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('tab', { name: 'Profile', exact: true })).toBeFocused();
    await fits(page, dialog);
    await page.keyboard.press('ArrowLeft');
    await expect(dialog.getByRole('tab', { name: 'Appearance', exact: true })).toBeFocused();
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await expect(dialog).toHaveCount(0);
});
