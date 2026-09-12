import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { inspectSyntheticDevices } from '../../scripts/smoke-conference.mjs';

test('CI Chromium launch exposes only synthetic devices before capture and acquires real generated audio/video', async () => {
  // Keep this tied to the actual acceptance entry point. In Chromium153's
  // Headless Shell, CDP grantPermissions alone leaves labels blank and capture
  // rejects with NotSupportedError; the synthetic UI switch is also required.
  const source = await readFile('scripts/smoke-live.mjs', 'utf8');
  const launch = source.match(/chromium\.launch\(\{ args: \[([^\]]+)\]/)?.[1] || '';
  const flags = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  for (const flag of flags) expect(launch).toContain("'" + flag + "'");
  // Match the suite's explicit local browser override. CI leaves this unset
  // and still exercises Playwright's pinned Chromium/Headless Shell.
  const browser = await chromium.launch({ args: flags, executablePath: process.env.CHROME_PATH || undefined });
  try {
    const context = await browser.newContext(), page = await context.newPage();
    const origin = 'http://127.0.0.1:5173';
    await context.grantPermissions(['microphone', 'camera'], { origin });
    await page.route('**/conference-synthetic-proof', route => route.fulfill({ contentType: 'text/html', headers: {
      'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()',
    }, body: '<!doctype html><title>Synthetic conference device proof</title>' }));
    await page.goto(origin + '/conference-synthetic-proof');
    expect(await page.evaluate(inspectSyntheticDevices)).toBe('synthetic');
    // Only after the pre-capture check: exercise actual Chromium tracks, with
    // no peer connection, ICE, media server, physical capture or mocked SDK.
    expect(await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const tracks = stream.getTracks();
      try {
        return { audio: tracks.filter(t => t.kind === 'audio' && /^Fake (Default )?Audio Input(?: [0-9]+)?$/i.test(t.label) && t.readyState === 'live').length,
          video: tracks.filter(t => t.kind === 'video' && /^fake_device_[0-9]+$/i.test(t.label) && t.readyState === 'live').length };
      } finally { tracks.forEach(track => track.stop()); if (tracks.some(track => track.readyState !== 'ended')) throw new Error('Synthetic tracks did not stop.'); }
    })).toEqual({ audio: 1, video: 1 });
  } finally { await browser.close(); }
});
