import { expect, test, type Page } from '@playwright/test';
import { routeVoiceAvatar } from './voice-fixture-routes';

async function fixture(page: Page) {
  await routeVoiceAvatar(page);
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.voiceFixture?.client;export const onMatrixUpdate=fn=>{window.voiceFixture.listeners.add(fn);return()=>window.voiceFixture.listeners.delete(fn)};' }));
  await page.route(url => url.pathname === '/lib/calls.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const callSnapshot=()=>({call:window.voiceFixture.direct});export async function callsConfigured(){const f=window.voiceFixture;if(f.holdConfiguration)await new Promise(resolve=>f.releaseConfiguration=resolve);f.configurationReturns=(f.configurationReturns||0)+1;return f.configured;}` }));
  await page.route(url => url.pathname === '/lib/conference.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export async function mountConference(client,roomId,frame,onLeave,signal,onJoined,managed,onDevices,options={}){
    const f=window.voiceFixture;f.mounts.push({roomId,voiceOnly:options.voiceOnly});f.telemetry.push(options.onTelemetry);
    frame.srcdoc='<button>Widget device controls</button>';onJoined();onDevices({audio_enabled:true,video_enabled:!options.voiceOnly});
    const stop=async()=>{f.stops.push(roomId)};stop.setDevices=async value=>{f.deviceChanges??=[];f.deviceChanges.push(value);onDevices(value)};return stop;
  }` }));
  await page.route('**/voice-channel-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset='utf-8'></head><body><div id='root'></div><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/voice-channel.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/voice-channel-test'); await expect(page.getByRole('button', { name: 'Join voice', exact: true })).toBeVisible();
}
async function join(page: Page) {
  await page.getByRole('button', { name: 'Join voice', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conference in Voice lounge' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).voiceFixture.mounts.length)).toBe(1);
}

test('voice lobby uses current native membership, groups devices and never captures merely by browsing', async ({ page }) => {
  await fixture(page);
  const roster = page.locator('.voice-channel-presence');
  await expect(roster.locator('.voice-person')).toHaveCount(2);
  await expect(roster.getByText('2 devices', { exact: true })).toBeVisible();
  await expect(roster.getByText('Departed', { exact: true })).toHaveCount(0);
  await roster.locator('.voice-person').filter({ hasText: 'Guest' }).click();
  expect(await page.evaluate(() => (window as any).voiceFixture.profiles)).toEqual(['@guest:local']);
  await page.evaluate(() => (window as any).voiceFixture.member('!voice:local', '@guest:local', 'leave'));
  await expect(roster.locator('.voice-person')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).voiceFixture.captures)).toBe(0);
});

test('voice join retains the widget until telemetry arrives and exposes actual measured status and device controls', async ({ page }) => {
  await fixture(page); await join(page);
  const panel = page.getByRole('region', { name: 'Conference in Voice lounge' });
  expect(await page.evaluate(() => (window as any).voiceFixture.mounts)).toEqual([{ roomId: '!voice:local', voiceOnly: true }]);
  await expect(panel.getByRole('button', { name: /conference camera/ })).toHaveCount(0);
  const frame = panel.locator('iframe'); await expect(frame).toHaveAttribute('allow', /camera 'none'.*display-capture 'none'/);
  await expect(frame).not.toHaveClass(/voice-frame-hidden/); await expect(page.getByText('Voice connected', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).voiceFixture; f.publish(f.sample()); });
  await expect(page.getByText('Voice connected', { exact: true })).toBeVisible(); await expect(page.getByText('Ping: 42 ms', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View Guest profile, speaking', exact: true })).toHaveClass(/voice-speaking/);
  await expect(page.getByText('End-to-end encryption enabled', { exact: true })).toBeVisible(); await expect(frame).toHaveClass(/voice-frame-hidden/);
  await page.getByText('Connection details', { exact: true }).click(); await expect(page.getByText('2.3 ms', { exact: true })).toBeVisible(); await expect(page.getByText('0.5%', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Mute conference microphone', exact: true }).click();
  expect(await page.evaluate(() => (window as any).voiceFixture.deviceChanges)).toEqual([{ audio_enabled: false }]);
  await page.getByRole('button', { name: 'Call controls and devices', exact: true }).click(); await expect(frame).not.toHaveClass(/voice-frame-hidden/);
  await page.getByRole('button', { name: 'Show voice participants', exact: true }).click(); await expect(frame).toHaveClass(/voice-frame-hidden/);
  expect(await page.evaluate(() => (window as any).voiceFixture.captures)).toBe(0);
});

test('telemetry loss removes stale measurements and restores the existing widget, without remounting media', async ({ page }) => {
  await fixture(page); await join(page);
  await page.evaluate(() => { const f = (window as any).voiceFixture; const value = f.sample(); value.metrics = { rttMs: null, jitterMs: null, packetLossPercent: null, sampledTracks: 0, totalTracks: 2 }; value.e2eeEnabled = null; value.participants.forEach((peer: any) => { peer.e2eeEnabled = null; peer.encrypted = null; }); f.publish(value); });
  await expect(page.getByText('Ping: Measuring…', { exact: true })).toBeVisible(); await expect(page.getByText('Checking voice encryption…', { exact: true })).toBeVisible();
  await page.getByText('Connection details', { exact: true }).click(); await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(2);
  await page.evaluate(() => (window as any).voiceFixture.publish(null));
  await expect(page.getByText('Voice connected', { exact: true })).toHaveCount(0); await expect(page.locator('iframe')).not.toHaveClass(/voice-frame-hidden/);
  expect(await page.evaluate(() => (window as any).voiceFixture.mounts.length)).toBe(1);
});

test('encryption success requires complete observations and known encryption for every peer', async ({ page }) => {
  await fixture(page); await join(page);
  for (const missing of ['encrypted', 'e2eeEnabled', 'complete']) {
    await page.evaluate(field => { const f = (window as any).voiceFixture, value = f.sample(); if (field === 'complete') value.complete = false; else value.participants[1][field] = null; f.publish(value); }, missing);
    await expect(page.getByText('End-to-end encryption enabled', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Checking voice encryption…', { exact: true })).toBeVisible();
  }
  await page.evaluate(() => { const f = (window as any).voiceFixture, value = f.sample(); value.participants[1].encrypted = false; f.publish(value); });
  await expect(page.getByText('Encryption needs attention. Leave and rejoin the call.', { exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).voiceFixture; f.publish(f.sample()); });
  await expect(page.getByText('End-to-end encryption enabled', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceFixture.captures)).toBe(0);
});

test('navigation docks the persistent call and restoring its page keeps the same mounted conference', async ({ page }) => {
  await fixture(page); await join(page);
  const panel = page.getByRole('region', { name: 'Conference in Voice lounge' }); await expect(panel).toHaveClass(/voice-inline/);
  await page.evaluate(() => (window as any).voiceFixture.render(''));
  await expect(panel).toHaveClass(/conference-minimized/); await expect(panel).not.toHaveClass(/voice-inline/);
  await page.evaluate(() => (window as any).voiceFixture.render('!voice:local'));
  await expect(panel).toHaveClass(/voice-inline/); await expect(panel).not.toHaveClass(/conference-minimized/);
  expect(await page.evaluate(() => (window as any).voiceFixture.mounts.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).voiceFixture.stops)).toEqual([]);
});

test('current account, room membership and kind changes close the old conference and reject late telemetry', async ({ page }) => {
  for (const change of ['account', 'membership', 'kind']) {
    await fixture(page); await join(page);
    await page.evaluate(operation => { const f = (window as any).voiceFixture; if (operation === 'account') f.account(); else if (operation === 'membership') f.member('!voice:local', '@owner:local', 'leave'); else f.kind('video'); }, change);
    await expect(page.getByRole('region', { name: /^Conference in/ })).toHaveCount(0);
    await page.evaluate(() => { const f = (window as any).voiceFixture; f.publish(f.sample(), 0); });
    await expect(page.getByText('Voice connected', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).voiceFixture.snapshot().phase)).toBe('idle');
    expect(await page.evaluate(() => (window as any).voiceFixture.captures)).toBe(0);
  }
});

test('video conferences retain their camera controls and never adopt voice-only iframe restrictions', async ({ page }) => {
  await fixture(page); await page.evaluate(() => (window as any).voiceFixture.open('!video:local'));
  const panel = page.getByRole('region', { name: 'Conference in Video meeting' }); await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Disable conference camera', exact: true })).toBeVisible();
  await expect(panel.locator('iframe')).toHaveAttribute('allow', 'camera; microphone; display-capture; autoplay; fullscreen');
  expect(await page.evaluate(() => (window as any).voiceFixture.mounts)).toEqual([{ roomId: '!video:local', voiceOnly: false }]);
});

test('active call failure exposes only safe copied details and does not leak into a replacement call', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await fixture(page); await join(page);
  await page.evaluate(() => { const f = (window as any).voiceFixture, value = f.sample(); value.failure = { code: 'CONNECTION_LOST_ERROR', cause: 'MatrixError', status: 403, reason: null, matrixCode: 'M_FORBIDDEN' }; f.publish(value); });
  const details = page.getByRole('alert', { name: 'Call error details' });
  await expect(details).toContainText('could not keep its room membership active');
  await expect(details).toContainText('M_FORBIDDEN');
  await expect(page.locator('iframe')).not.toHaveClass(/voice-frame-hidden/);
  await details.getByRole('button', { name: 'Copy call error details', exact: true }).click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual({ code: 'CONNECTION_LOST_ERROR', cause: 'MatrixError', status: 403, reason: null, matrixCode: 'M_FORBIDDEN' });
  await page.getByRole('button', { name: 'Leave conference', exact: true }).click();
  await expect(details).toHaveCount(0);
  await page.getByRole('button', { name: 'Join voice', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).voiceFixture.mounts.length)).toBe(2);
  await page.evaluate(() => { const f = (window as any).voiceFixture, value = f.sample(); value.failure = { code: 'UNKNOWN_ERROR', cause: null, status: null, reason: null, matrixCode: null }; f.publish(value, 0); });
  await expect(details).toHaveCount(0);
});

test('a pending voice join cannot open its old room after the keyed page is unmounted', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { (window as any).voiceFixture.holdConfiguration = true; });
  await page.getByRole('button', { name: 'Join voice', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).voiceFixture.releaseConfiguration)).toBe(true);
  await page.evaluate(() => (window as any).voiceFixture.render('!other:local'));
  await expect(page.getByRole('heading', { name: 'Other lounge', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).voiceFixture.releaseConfiguration());
  await expect.poll(() => page.evaluate(() => (window as any).voiceFixture.configurationReturns)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).voiceFixture.snapshot().roomId)).toBe(null);
  expect(await page.evaluate(() => (window as any).voiceFixture.mounts)).toEqual([]);
});

test('pending access checks cannot join after account, native identity, room or channel changes', async ({ page }) => {
  for (const change of ['account', 'actor', 'device', 'room', 'membership', 'kind']) {
    await fixture(page); await page.evaluate(() => { (window as any).voiceFixture.holdConfiguration = true; });
    await page.getByRole('button', { name: 'Join voice', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!(window as any).voiceFixture.releaseConfiguration)).toBe(true);
    await page.evaluate(operation => { const f = (window as any).voiceFixture;
      if (operation === 'account') f.account();
      else if (operation === 'actor') f.client.getUserId = () => '@guest:local';
      else if (operation === 'device') f.client.getDeviceId = () => 'D2';
      else if (operation === 'room') f.replaceRoom();
      else if (operation === 'membership') f.member('!voice:local', '@owner:local', 'leave');
      else f.kind('video');
      f.releaseConfiguration();
    }, change);
    await expect.poll(() => page.evaluate(() => (window as any).voiceFixture.configurationReturns)).toBe(1);
    expect(await page.evaluate(() => (window as any).voiceFixture.snapshot().roomId), change).toBe(null);
    expect(await page.evaluate(() => (window as any).voiceFixture.mounts), change).toEqual([]);
  }
});

test('connected voice participants and existing device controls fit phone and desktop viewports', async ({ page }) => {
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page); await join(page);
    await page.evaluate(() => { const f = (window as any).voiceFixture; f.publish(f.sample()); });
    const panel = page.getByRole('region', { name: 'Conference in Voice lounge' });
    await expect(page.getByText('Voice connected', { exact: true })).toBeVisible();
    await page.screenshot({ path: `work/voice-roster-${width}.png`, fullPage: true });
    const within = await panel.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= -1 && rect.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1; });
    expect(within, `Voice panel should fit ${width}px without horizontal document overflow`).toBe(true);
    await page.getByRole('button', { name: 'Call controls and devices', exact: true }).click();
    await expect(panel.locator('iframe')).not.toHaveClass(/voice-frame-hidden/);
    await page.screenshot({ path: `work/voice-device-controls-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => (window as any).voiceFixture.mounts.length)).toBe(1);
  }
});
