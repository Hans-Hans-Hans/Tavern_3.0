import { test, expect } from '@playwright/test';
for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) test(`app status reserves composer space at ${viewport.width}px and releases it when dismissed`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await page.route(url => url.pathname === '/lib/pwa.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const pwaSnapshot=()=>window.statusState;export const subscribePwa=fn=>{window.statusListeners.add(fn);return()=>window.statusListeners.delete(fn)};export const initializePwa=()=>{};export const applyAppUpdate=async()=>{};export const installTavern=async()=>false;export const reconnectTavern=async()=>{};' }));
  await page.route('**/pwa-status-test', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/pwa-status.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/pwa-status-test'); await expect(page.getByRole('status')).toContainText('storage is unavailable');
  const initial = await page.evaluate(() => ({ app: document.querySelector('.tavern-root')!.getBoundingClientRect().toJSON(), banner: document.querySelector('.pwa-status')!.getBoundingClientRect().toJSON() }));
  expect(initial.app.top).toBeGreaterThanOrEqual(initial.banner.bottom); expect(initial.app.bottom).toBeLessThanOrEqual(viewport.height + 1);
  await page.getByRole('button', { name: 'Send message' }).click(); expect(await page.evaluate(() => (window as any).clicks)).toBe(1);
  await page.getByRole('button', { name: 'Dismiss app status' }).click(); await expect(page.getByRole('status')).toHaveCount(0);
  await expect.poll(() => page.locator('.tavern-root').evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(viewport.height);
  await page.evaluate(() => { const w = window as any; w.statusState = { ...w.statusState, online: false, message: '' }; w.statusListeners.forEach((listener: () => void) => listener()); });
  await expect(page.getByRole('status')).toContainText('You’re offline'); await page.getByRole('button', { name: 'Send message' }).click(); expect(await page.evaluate(() => (window as any).clicks)).toBe(2);
});
