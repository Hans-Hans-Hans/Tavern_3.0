import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;' }));
  await page.route(url => url.pathname === '/lib/security.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const requestPeerVerification=async()=>{};' }));
  await page.route(url => url.pathname === '/lib/calls.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const callSnapshot=()=>window.fixtureSnapshot;export const subscribeCalls=fn=>{window.fixtureListeners.add(fn);return()=>window.fixtureListeners.delete(fn)};export const watchFeed=(feed,fn)=>{feed.on('new_stream',fn);feed.on('mute_state_changed',fn);return()=>{feed.off('new_stream',fn);feed.off('mute_state_changed',fn)}};export const callsConfigured=async()=>true;export const endCall=()=>window.fixtureEndCall();export const answerCall=async()=>{};export const startCall=async()=>{};export const toggleCall=async()=>{};export const setCallMediaSettings=async()=>{};export const setCallTalking=async()=>{};` }));
  await page.route('**/call-stream-quality-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/call-stream-quality.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/call-stream-quality-test'); await page.getByRole('button', { name: 'Start synthetic quality call', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Active call' })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => [...(await (window as any).fixtureQuality.first.getStats()).values()].filter((value: any) => value.type === 'outbound-rtp' && value.kind === 'video').reduce((sum: number, value: any) => sum + (value.bytesSent || 0), 0))).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Call device settings' }).click();
  await expect(page.getByRole('region', { name: 'Outgoing stream quality' })).toBeVisible();
}

test('camera presets apply to a real canvas/WebRTC sender, report actual measurements and restore call defaults', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).fixtureQuality; f.camera.enabled = false; f.call.emit('feeds_changed'); });
  await page.getByRole('combobox', { name: 'Camera quality', exact: true }).selectOption('low');
  const camera = page.getByRole('group', { name: 'Camera', exact: true });
  await expect.poll(() => page.evaluate(() => (window as any).fixtureQuality.cameraSender.getParameters().encodings[0].maxBitrate)).toBe(500000);
  await expect(camera.getByText('0.5 Mbps', { exact: true })).toBeVisible(); await expect(camera.getByText('15 fps', { exact: true }).last()).toBeVisible();
  const settings = await page.evaluate(() => { const value = (window as any).fixtureQuality.camera.getSettings(); return { width: value.width, height: value.height, frameRate: value.frameRate }; });
  await expect(camera.getByText(`${settings.width} × ${settings.height}`, { exact: true })).toBeVisible();
  await expect(camera.getByText('This video track is disabled. Changing quality does not enable it.')).toBeVisible();
  expect(await page.evaluate(() => { const f = (window as any).fixtureQuality; return { live: f.camera.readyState, enabled: f.camera.enabled, audio: f.audioSender.getParameters().encodings, originalAudio: f.originalAudio, captures: (window as any).fixtureCaptureRequests }; })).toEqual(expect.objectContaining({ live: 'live', enabled: false, captures: 0 }));
  expect(await page.evaluate(() => { const f = (window as any).fixtureQuality; return JSON.stringify(f.audioSender.getParameters().encodings) === JSON.stringify(f.originalAudio); })).toBe(true);
  await page.getByRole('combobox', { name: 'Camera quality', exact: true }).selectOption('automatic');
  await expect(camera.getByRole('status')).toHaveText('Call default constraints and send limits restored.');
  expect(await page.evaluate(() => { const f = (window as any).fixtureQuality; return { actualCapture: f.camera.getConstraints(), originalCapture: f.originalCapture, actualEncoding: f.cameraSender.getParameters().encodings, originalEncoding: f.originalEncoding }; })).toEqual(expect.objectContaining({ actualCapture: {}, originalCapture: {} }));
  expect(await page.evaluate(() => { const f = (window as any).fixtureQuality; return JSON.stringify(f.cameraSender.getParameters().encodings) === JSON.stringify(f.originalEncoding); })).toBe(true);
  await page.evaluate(() => (window as any).fixtureEndCall());
});

test('screen choice waits for an existing source, applies to its own real sender and survives panel unmount without stopping media', async ({ page }) => {
  await fixture(page); const screen = page.getByRole('group', { name: 'Screen share', exact: true });
  await page.getByRole('combobox', { name: 'Screen share quality', exact: true }).selectOption('text');
  await expect(screen.getByRole('status')).toHaveText('Waiting for your video source.');
  expect(await page.evaluate(() => ({ captures: (window as any).fixtureCaptureRequests, screen: !!(window as any).fixtureQuality.call.localScreensharingStream }))).toEqual({ captures: 0, screen: false });
  await page.getByRole('button', { name: 'Add existing synthetic screen' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixtureQuality.screenSender?.getParameters().encodings[0].maxBitrate)).toBe(2500000);
  await expect(screen.getByText('2.5 Mbps', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => { const f = (window as any).fixtureQuality; return JSON.stringify(f.cameraSender.getParameters().encodings) === JSON.stringify(f.originalEncoding); })).toBe(true);
  await page.getByRole('button', { name: 'Toggle quality panel mount' }).click();
  await expect(page.getByRole('region', { name: 'Active call' })).toHaveCount(0);
  expect(await page.evaluate(() => { const f = (window as any).fixtureQuality; return [f.camera, f.screen, f.audio].every((track: MediaStreamTrack) => track.readyState === 'live'); })).toBe(true);
  await page.getByRole('button', { name: 'Toggle quality panel mount' }).click(); await page.getByRole('button', { name: 'Call device settings' }).click();
  await expect(page.getByRole('combobox', { name: 'Screen share quality', exact: true })).toHaveValue('text');
  await page.getByRole('combobox', { name: 'Screen share quality', exact: true }).selectOption('automatic');
  await expect(screen.getByRole('status')).toHaveText('Call default constraints and send limits restored.');
  expect(await page.evaluate(() => (window as any).fixtureCaptureRequests)).toBe(0); await page.evaluate(() => (window as any).fixtureEndCall());
});
