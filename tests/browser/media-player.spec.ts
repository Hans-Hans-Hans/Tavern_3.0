import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function fixture(page: Page) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const matrixFileBlob=async item=>item.id==='video'?window.fixtureVideo:new Blob(['other']);export const downloadMatrixFile=async()=>{};` }));
  await page.route('**/media-player-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/tests/browser/fixtures/media-player.tsx');</script></body></html>` }));
  await page.goto('/media-player-test'); await page.getByRole('button', { name: 'Prepare local recording' }).click();
  await expect(page.getByRole('button', { name: 'Open video', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Open video', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate(video => ({ ready: video.readyState > 0, source: video.getAttribute('src')?.startsWith('blob:'), error: video.error?.message || '' }))).toEqual({ ready: true, source: true, error: '' });
  await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeEnabled();
}
test('local video poster uses real decoded dimensions and invalid/aborted files release their URLs', async ({ page }) => {
  await fixture(page);
  expect(await page.evaluate(async () => { const p = (window as any).fixturePreview; return { width: p?.width, height: p?.height, bytes: p?.blob.size, type: p?.blob.type, sourceWidth: p?.sourceWidth, sourceHeight: p?.sourceHeight, duration: p?.duration }; })).toMatchObject({ width: 160, height: 90, type: 'image/webp', sourceWidth: 160, sourceHeight: 90, duration: 4000 });
  const boundary = await page.evaluate(async () => {
    const { createMediaPreview } = await import('/lib/media-processing.ts'); const created: string[] = [], revoked: string[] = [], originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = blob => { const value = originalCreate(blob); created.push(value); return value; }; URL.revokeObjectURL = value => { revoked.push(value); originalRevoke(value); };
    try {
      const invalid = await createMediaPreview(new File(['invalid'], 'broken.webm', { type: 'video/webm' }));
      const controller = new AbortController(), pending = createMediaPreview((window as any).fixtureVideo, controller.signal); controller.abort(); let aborted = false; try { await pending; } catch { aborted = true; }
      return { invalid, aborted, created: created.length, completeCleanup: created.every(value => revoked.includes(value)) };
    } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
  });
  expect(boundary).toEqual({ invalid: null, aborted: true, created: 2, completeCleanup: true });
});
test('video controls operate actual playback and keep gallery navigation separate from seeking', async ({ page }, testInfo) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Mute video', exact: true }).click(); expect(await page.locator('video').evaluate(video => video.muted)).toBe(true);
  await page.getByRole('combobox', { name: 'Playback speed' }).selectOption('0.5'); expect(await page.locator('video').evaluate(video => video.playbackRate)).toBe(.5);
  await page.getByRole('button', { name: 'Play video', exact: true }).click(); await expect(page.getByRole('button', { name: 'Pause video', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause video', exact: true }).click(); expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
  await page.getByRole('slider', { name: 'Video position' }).fill('2'); await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBe(2);
  const downloading = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download', exact: true }).click(); const download = await downloading;
  expect(download.suggestedFilename()).toBe('Recording.webm'); const path = testInfo.outputPath('download.webm'); await download.saveAs(path);
  expect(await readFile(path)).toEqual(await readFile(new URL('./fixtures/recording.webm', import.meta.url)));
  const player = page.getByRole('region', { name: 'Video player: Recording.webm' }); await player.focus(); await page.keyboard.press('ArrowRight'); await expect(page.getByRole('heading', { name: 'Recording.webm' })).toBeVisible();
  await page.getByRole('button', { name: 'Next attachment' }).click(); await expect(page.getByRole('heading', { name: 'Other file' })).toBeVisible(); await expect(player).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('native video fullscreen and Picture-in-Picture are released when the viewer closes', async ({ page }) => {
  await fixture(page);
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await page.getByRole('button', { name: 'Show video fullscreen' }).click(); await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('media-player'))).toBe(true);
    await page.getByRole('button', { name: 'Exit video fullscreen' }).click(); await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  }
  if (await page.evaluate(() => document.pictureInPictureEnabled)) {
    await page.getByRole('button', { name: 'Show video Picture-in-Picture' }).click(); await expect.poll(() => page.evaluate(() => document.pictureInPictureElement !== null)).toBe(true);
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect.poll(() => page.evaluate(() => document.pictureInPictureElement === null)).toBe(true);
  }
});

test('video playback controls remain reachable on a phone viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page);
  const controls = page.locator('.media-player-controls');
  await expect(controls).toBeVisible();
  for (const button of await controls.getByRole('button').all()) {
    const box = await button.boundingBox(); expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390); expect(box!.y + box!.height).toBeLessThanOrEqual(844); expect(box!.height).toBeGreaterThanOrEqual(40);
  }
  await page.screenshot({ path: testInfo.outputPath('phone-player.png') });
  await page.getByRole('button', { name: 'Play video', exact: true }).click(); await expect(page.getByRole('button', { name: 'Pause video', exact: true })).toBeVisible();
});
