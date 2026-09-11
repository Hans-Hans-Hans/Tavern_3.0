import { test, expect, type Page } from '@playwright/test';
import { routeVoiceAvatar } from './voice-fixture-routes';

async function fixture(page: Page) {
  await routeVoiceAvatar(page);
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const mutateMatrixAccountData=async()=>{throw new Error("Read-only voice fixture cannot write account data")};export const getMatrixClient=()=>window.voiceFixture?.client;export const onMatrixUpdate=fn=>{window.voiceFixture.listeners.add(fn);return()=>window.voiceFixture.listeners.delete(fn)};' }));
  await page.route(url => url.pathname === '/lib/calls.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const callSnapshot=()=>({call:null});export const callsConfigured=async()=>true;' }));
  await page.route(url => url.pathname === '/lib/conference.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export async function mountConference(client,roomId,frame,onLeave,signal,onJoined,managed,onDevices,options={}){
    const f=window.voiceFixture;f.mounts.push({roomId,voiceOnly:options.voiceOnly});f.telemetry.push(options.onTelemetry);
    frame.srcdoc='<button>Widget device controls</button>';onJoined();onDevices({audio_enabled:true,video_enabled:!options.voiceOnly});
    const stop=async()=>{f.stops.push(roomId)};stop.setDevices=async value=>{f.deviceChanges??=[];f.deviceChanges.push(value);if(f.holdDevice)await new Promise(resolve=>f.releaseDevice=resolve);onDevices(value)};return stop;
  }` }));
  await page.route('**/voice-sidebar-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset='utf-8'></head><body><div id='root'></div><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/voice-sidebar.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/voice-sidebar-test'); await expect(page.getByRole('button', { name: 'Join voice', exact: true })).toBeVisible();
  return page.getByRole('complementary', { name: 'Voice channel sidebar' });
}
async function join(page: Page) {
  await page.getByRole('button', { name: 'Join voice', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Current voice call' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mute voice microphone', exact: true })).toBeEnabled();
}

test('sidebar rows come from native call devices, expire and disappear on kick without opening a call', async ({ page }) => {
  const sidebar = await fixture(page), list = sidebar.getByRole('list', { name: 'Voice participants in Voice lounge', exact: true });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('button', { name: /Owner \(you\).*status unavailable/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current voice call' })).toHaveCount(0);
  await list.getByRole('button', { name: /View Guest/ }).click();
  expect(await page.evaluate(() => (window as any).voiceFixture.profiles)).toEqual(['@guest:local']);
  await page.evaluate(() => (window as any).voiceFixture.expire('!voice:local', '@guest:local'));
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await page.evaluate(() => (window as any).voiceFixture.member('!voice:local', '@owner:local', 'leave'));
  await expect(list).toHaveCount(0);
  expect(await page.evaluate(() => ({ captures: (window as any).voiceFixture.captures, mounts: (window as any).voiceFixture.mounts.length }))).toEqual({ captures: 0, mounts: 0 });
});

test('known device state is scoped to its exact native device and telemetry loss clears indicators', async ({ page }) => {
  const sidebar = await fixture(page); await join(page);
  const list = sidebar.getByRole('list', { name: 'Voice participants in Voice lounge', exact: true });
  await page.evaluate(() => { const f = (window as any).voiceFixture; f.publish(f.sample()); });
  await expect(list.getByRole('button', { name: /View Guest, Speaking/ })).toBeVisible();
  await expect(sidebar.getByRole('list', { name: 'Voice participants in Other lounge' }).getByRole('button', { name: /View Guest.*status unavailable/ })).toBeVisible();
  await page.evaluate(() => (window as any).voiceFixture.replaceDevice('D2', 'REPLACED'));
  await expect(list.getByRole('button', { name: /View Guest.*status unavailable/ })).toBeVisible();
  await expect(list.locator('.is-speaking')).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).voiceFixture, value = f.sample(); value.participants = ['REPLACED', 'D3'].map(deviceId => ({ ...value.participants[1], identity: deviceId, deviceId, microphoneEnabled: false, speaking: false, cameraEnabled: true, screenShareEnabled: true })); f.publish(value); });
  await expect(list.getByRole('button', { name: /Microphone muted, Camera on, Sharing screen/ })).toBeVisible();
  await page.evaluate(() => (window as any).voiceFixture.publish(null));
  await expect(list.getByRole('button', { name: /View Guest.*status unavailable/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current voice call' })).toContainText('Checking voice connection');
});

test('bottom dock controls the persistent widget and navigation never remounts it', async ({ page }) => {
  const sidebar = await fixture(page); await join(page); const dock = sidebar.getByRole('region', { name: 'Current voice call' });
  await expect(dock).toContainText('Checking voice connection');
  await page.evaluate(() => { const f = (window as any).voiceFixture; f.publish(f.sample()); f.render('!other:local'); });
  await expect(dock).toContainText('Voice connected'); await expect(dock).toContainText('Voice lounge');
  await dock.getByRole('button', { name: 'Mute voice microphone', exact: true }).click();
  await expect(dock.getByRole('button', { name: 'Unmute voice microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as any).voiceFixture.deviceChanges)).toEqual([{ audio_enabled: false }]);
  await dock.getByRole('button', { name: 'Voice settings and call controls', exact: true }).click();
  await expect(page.locator('iframe[title="Tavern encrypted conference"]')).not.toHaveClass(/voice-frame-hidden/);
  await dock.getByRole('button', { name: 'Open voice channel Voice lounge', exact: true }).click();
  expect(await page.evaluate(() => (window as any).voiceFixture.selected)).toBe('!voice:local');
  expect(await page.evaluate(() => (window as any).voiceFixture.mounts.length)).toBe(1);
  await expect(dock.getByRole('button', { name: /deafen/i })).toHaveCount(0);
  await dock.getByRole('button', { name: 'Disconnect voice', exact: true }).click(); await expect(dock).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).voiceFixture.stops)).toEqual(['!voice:local']);
});

test('a retired account cannot publish a pending device response into a replacement call', async ({ page }) => {
  const sidebar = await fixture(page); await join(page);
  await page.evaluate(() => { (window as any).voiceFixture.holdDevice = true; });
  await sidebar.getByRole('button', { name: 'Mute voice microphone', exact: true }).click();
  await expect(sidebar.getByRole('button', { name: 'Mute voice microphone', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).voiceFixture.account());
  await expect(sidebar.getByRole('region', { name: 'Current voice call' })).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).voiceFixture; f.holdDevice = false; f.open('!other:local'); });
  await expect(sidebar.getByRole('button', { name: 'Mute voice microphone', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).voiceFixture.releaseDevice());
  await expect(sidebar.getByRole('button', { name: 'Mute voice microphone', exact: true })).toBeEnabled();
  await expect(sidebar.getByRole('region', { name: 'Current voice call' })).toContainText('Other lounge');
});

test('sidebar participants and dock fit a narrow touch viewport with usable controls', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 650 }); const sidebar = await fixture(page); await join(page);
  await page.evaluate(() => { const f = (window as any).voiceFixture; f.publish(f.sample()); });
  const dimensions = await sidebar.evaluate(element => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth, inner: element.clientWidth }));
  expect(dimensions.width).toBeLessThanOrEqual(320); expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.inner);
  for (const button of await sidebar.locator('.voice-sidebar-controls button').all()) { const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(34); expect(box!.width).toBeGreaterThanOrEqual(34); }
  await sidebar.screenshot({ path: 'work/voice-sidebar-320.png' });
});
