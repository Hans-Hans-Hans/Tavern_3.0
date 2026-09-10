import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.fixtureClient;' }));
  await page.route(url => url.pathname === '/lib/security.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const requestPeerVerification=async()=>{};' }));
  await page.route(url => url.pathname === '/lib/calls.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const callSnapshot=()=>window.fixtureSnapshot;export const subscribeCalls=fn=>{window.fixtureListeners.add(fn);return()=>window.fixtureListeners.delete(fn)};export const watchFeed=(feed,fn)=>{feed.on('new_stream',fn);feed.on('mute_state_changed',fn);return()=>{feed.off('new_stream',fn);feed.off('mute_state_changed',fn)}};export const callsConfigured=async()=>true;export const endCall=()=>window.fixtureEndCall();export const answerCall=async()=>{};export const startCall=async()=>{};export const toggleCall=async()=>{};export const setCallMediaSettings=async()=>{};export const setCallTalking=async()=>{};` }));
  await page.route('**/call-presentation-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/call-presentation.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/call-presentation-test'); await page.getByRole('button', { name: 'Start synthetic call', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Active call' })).toBeVisible();
  await expect.poll(() => page.locator('.call-feed video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
}

test('existing call streams provide real speech feedback and WebRTC measurements without new capture', async ({ page }) => {
  await fixture(page);
  await expect(page.getByLabel('Peer is speaking')).toBeVisible(); await expect(page.getByRole('meter', { name: 'Speech activity for Peer' })).toHaveAttribute('aria-valuenow', /[1-9]/);
  await page.getByText(/Connection details/).click();
  await expect.poll(() => page.locator('.call-connection').innerText()).toMatch(/Upload media rate\s+[\d.]+ kbps/);
  await expect.poll(() => page.locator('.call-connection').innerText()).toMatch(/Download media rate\s+[\d.]+ kbps/);
  await page.getByRole('button', { name: 'Silence synthetic audio' }).click(); await expect(page.getByLabel('Peer is speaking')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).fixtureCaptureRequests)).toBe(0);
  await page.getByRole('button', { name: 'Hide call panel' }).click();
  expect(await page.evaluate(() => (window as any).fixtureStreams.flatMap((stream: MediaStream) => stream.getTracks()).every((track: MediaStreamTrack) => track.readyState === 'live'))).toBe(true);
  expect(await page.evaluate(() => (window as any).fixtureFeed.listenerCount('speaking'))).toBe(0);
  await page.evaluate(() => (window as any).fixtureEndCall());
});

test('native fullscreen exits when participant navigation minimizes the call', async ({ page }) => {
  await fixture(page);
  const supported = await page.evaluate(() => document.fullscreenEnabled);
  if (!supported) { await expect(page.getByRole('button', { name: 'Show call fullscreen' })).toBeDisabled(); await page.evaluate(() => (window as any).fixtureEndCall()); return; }
  await page.getByRole('button', { name: 'Show call fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('call-panel'))).toBe(true);
  await page.locator('.call-feed-header').getByRole('button', { name: 'Peer', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Active call' })).toHaveClass(/call-minimized/); await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(page.getByRole('button', { name: 'Expand call' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixtureCaptureRequests)).toBe(0); await page.evaluate(() => (window as any).fixtureEndCall());
});

test('native video Picture-in-Picture uses the existing live video and preserves the stream on exit', async ({ page }) => {
  await fixture(page);
  const button = page.getByRole('button', { name: 'Picture-in-Picture for Peer', exact: true });
  const supported = await page.evaluate(() => document.pictureInPictureEnabled && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function');
  if (!supported) { await expect(button).toBeDisabled(); await expect(page.getByText('This browser does not offer video Picture-in-Picture.')).toBeVisible(); await page.evaluate(() => (window as any).fixtureEndCall()); return; }
  await button.click();
  await expect.poll(() => page.evaluate(() => document.pictureInPictureElement === document.querySelector('.call-feed video'))).toBe(true);
  await page.getByRole('button', { name: 'Exit Picture-in-Picture for Peer' }).click(); await expect.poll(() => page.evaluate(() => document.pictureInPictureElement === null)).toBe(true);
  expect(await page.evaluate(() => (window as any).fixtureStreams.flatMap((stream: MediaStream) => stream.getTracks()).every((track: MediaStreamTrack) => track.readyState === 'live'))).toBe(true);
  expect(await page.evaluate(() => (window as any).fixtureCaptureRequests)).toBe(0); await page.evaluate(() => (window as any).fixtureEndCall());
});

test('direct-call header shares measurements and reports failed, disconnected and recovered transport truthfully', async ({ page }) => {
  await fixture(page);
  const header = page.locator('.call-panel > header small');
  await expect(header).toHaveText('Connected · Relay route not confirmed');
  // Presentation-only state/report injection on the existing real peer; this
  // does not claim the local synthetic connection used an actual TURN service.
  await page.evaluate(() => {
    const w = window as any, call = w.fixtureSnapshot.call, peer = call.peerConn;
    w.qualityReads = 0;
    call.getCurrentCallStats = async () => { w.qualityReads++; return w.qualityRows; };
    w.qualityRows = [];
    w.setQualityState = (connection: string, ice: string) => {
      Object.defineProperty(peer, 'connectionState', { configurable: true, value: connection });
      Object.defineProperty(peer, 'iceConnectionState', { configurable: true, value: ice });
      peer.dispatchEvent(new Event('connectionstatechange'));
    };
    w.setQualityState('failed', 'disconnected');
  });
  await expect(header).toHaveText('Connection failed');
  await expect(page.getByRole('status').filter({ hasText: 'successful allocation alone' })).toBeVisible();
  await page.getByText(/Connection details/).click();
  await expect(page.locator('.call-connection')).toContainText('Local relay candidates0');
  await expect(page.locator('.call-connection')).toContainText('Remote ICE candidates0');
  await expect(page.locator('.call-connection')).toContainText('ICE gatheringcomplete');
  const before = await page.evaluate(() => (window as any).qualityReads);
  await page.evaluate(() => (window as any).setQualityState('disconnected', 'disconnected'));
  await expect(header).toHaveText('Media disconnected');
  expect(await page.evaluate(() => (window as any).qualityReads)).toBe(before, 'Native transport state does not launch a second getStats poll');
  await page.evaluate(() => {
    const w = window as any;
    w.qualityRows = [{ id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }, { id: 'pair', type: 'candidate-pair', localCandidateId: 'relay', state: 'succeeded' }, { id: 'relay', type: 'local-candidate', candidateType: 'relay', address: '192.0.2.4' }, { id: 'remote', type: 'remote-candidate', address: '198.51.100.5' }];
    w.setQualityState('connected', 'connected');
  });
  await expect(header).toHaveText('Connected · Relayed encrypted media');
  await expect(page.locator('.call-connection')).toContainText('Local relay candidates1');
  await expect(page.getByRole('status').filter({ hasText: 'media connection' })).toHaveCount(0);
  await expect(page.locator('.call-panel')).not.toContainText('192.0.2.4');
  expect(await page.evaluate(() => (window as any).fixtureCaptureRequests)).toBe(0);
  await page.evaluate(() => (window as any).fixtureEndCall());
});

test('a pending old-call sample cannot replace a new call or new account connection details', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.fixtureSnapshot.call.getCurrentCallStats = () => new Promise(resolve => { w.finishOldQuality = resolve; });
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishOldQuality)).toBe('function');
  await page.evaluate(() => {
    const w = window as any, old = w.fixtureSnapshot.call;
    w.fixtureSnapshot = { ...w.fixtureSnapshot, call: { ...old, callId: 'replacement-call', getCurrentCallStats: async () => [] } };
    for (const notify of w.fixtureListeners) notify();
  });
  const header = page.locator('.call-panel > header small');
  await expect(header).toHaveText('Connected · Relay route not confirmed');
  await page.evaluate(() => {
    const w = window as any;
    w.finishOldQuality([{ id: 'pair', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'relay' }, { id: 'relay', type: 'local-candidate', candidateType: 'relay' }]);
    w.fixtureClient = { ...w.fixtureClient, getUserId: () => '@replacement:local', getDeviceId: () => 'REPLACEMENT' };
    w.fixtureSnapshot = { ...w.fixtureSnapshot };
    for (const notify of w.fixtureListeners) notify();
  });
  await expect(header).not.toContainText('Relayed encrypted media');
  await page.evaluate(() => (window as any).fixtureEndCall());
});
