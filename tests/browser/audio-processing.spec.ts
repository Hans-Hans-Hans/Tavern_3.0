import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('real Chromium and pinned LiveKit replace microphone processing while retaining mute and one live capture', async ({ baseURL }) => {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], executablePath: process.env.CHROME_PATH || undefined });
  try {
    const context = await browser.newContext(), page = await context.newPage();
    const map = JSON.parse(await readFile('node_modules/@element-hq/element-call-embedded/dist/assets/index-DPkEeOAp.js.map', 'utf8'));
    const sdkIndex = map.sources.findIndex((name: string) => name.includes('livekit-client@2.22.0_') && name.endsWith('/livekit-client.esm.mjs'));
    if (sdkIndex < 0) throw new Error('Review the pinned LiveKit SDK source.');
    await page.route('**/pinned-audio-sdk.js', route => route.fulfill({ contentType: 'text/javascript', body: map.sourcesContent[sdkIndex] }));
    await context.grantPermissions(['microphone'], { origin: baseURL! });
    await page.route('**/microphone-processing-probe', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Microphone processing</title>' }));
    await page.goto(baseURL + '/microphone-processing-probe');
    await page.evaluate(async () => {
      const path = '/lib/audio-processing.ts', sdkPath = '/pinned-audio-sdk.js', audio = await import(/* @vite-ignore */ path), sdk = await import(/* @vite-ignore */ sdkPath), w = window as any;
      let captures = 0; const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = args => { captures++; return capture(args); };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audio.audioProcessingConstraints(audio.speechProcessing), video: false });
      const original = stream.getAudioTracks()[0], native = new sdk.LocalAudioTrack(original, original.getConstraints(), false); native.source = sdk.Track.Source.Microphone; await native.mute(); let closed = false;
      const controller = new audio.MicrophoneProcessingController(() => !closed, () => navigator.mediaDevices.getSupportedConstraints(), (value: unknown) => w.processingReport = value);
      const restart = { owner: native, current: () => !closed, run: async (settings: object) => { const track = native.mediaStreamTrack; await native.restartTrack({ ...track.getConstraints(), ...settings, deviceId: { exact: track.getSettings().deviceId } }); return native.mediaStreamTrack; } };
      w.processingProbe = { music: () => controller.refresh(native.mediaStreamTrack, audio.musicProcessing, restart), read: () => ({ captures, enabled: native.mediaStreamTrack.enabled, originalEnded: original.readyState === 'ended', live: native.mediaStreamTrack.readyState === 'live', muted: native.isMuted, report: w.processingReport }), stop: () => { closed = true; controller.dispose(); native.stop(); } };
      controller.refresh(native.mediaStreamTrack, audio.speechProcessing, restart);
    });
    await expect.poll(() => page.evaluate(() => (window as any).processingProbe.read().report?.state)).toBe('applied');
    expect(await page.evaluate(() => (window as any).processingProbe.read().captures)).toBe(1);
    await page.evaluate(() => (window as any).processingProbe.music());
    await expect.poll(() => page.evaluate(() => (window as any).processingProbe.read())).toEqual({ captures: 2, enabled: false, originalEnded: true, live: true, muted: true, report: { state: 'applied', noiseSuppression: false, echoCancellation: true, autoGainControl: false } });
    await page.evaluate(() => (window as any).processingProbe.stop());
  } finally { await browser.close(); }
});
