import { expect, test, type Page } from '@playwright/test';
const nonce = 'abcdefgh-1234-4567-8901-abcdefgh1234', widget = 'widgetab-1234-4567-8901-abcdefgh1234';
async function fixture(page: Page) {
  await page.route('**/telemetry-child*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>Telemetry fixture frame<script>addEventListener('message',event=>{if(event.source===parent&&event.origin===location.origin&&event.data.type==='io.tavern.call.telemetry.bind')window.telemetryDocument=event.data.document;});</script></body></html>` }));
  await page.route('http://foreign.telemetry.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Different origin fixture</body></html>' }));
  await page.route('**/telemetry-host', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><iframe id="call" src="/telemetry-child?call"></iframe><iframe id="other" src="/telemetry-child?other"></iframe><script type="module">
    import { observeConferenceTelemetry } from '/lib/conference-telemetry.ts';
    window.updates=[];window.owner={};window.messageEvents=0;addEventListener('message',()=>window.messageEvents++);window.bind=(session)=>{window.telemetryStop?.();const owner=window.owner;window.telemetryStop=observeConferenceTelemetry({iframe:document.getElementById('call'),widgetId:${JSON.stringify(widget)},session,roomId:'!voice:local',isCurrent:()=>window.owner===owner,onUpdate:value=>window.updates.push(value)});};
    window.bind(${JSON.stringify(nonce)});window.ready=true;
  </script></body></html>` }));
  await page.goto('/telemetry-host'); await page.waitForFunction(() => (window as any).ready);
  await expect.poll(() => page.frames().filter(frame => frame.url().includes('telemetry-child')).length).toBe(2);
  const frame = page.frames().find(frame => frame.url().includes('telemetry-child?call'))!;
  await frame.waitForFunction(() => (window as any).telemetryDocument);
}
function payload(sequence = 1) {
  return { type: 'io.tavern.call.telemetry', version: 1, widgetId: widget, session: nonce, roomId: '!voice:local', sequence,
    connected: true, reconnecting: false, participants: [{ identity: 'opaque-native', userId: '@speaker:local', deviceId: 'SPEAKER', displayName: 'Native speaker', avatarMxc: null,
      local: false, speaking: true, microphoneEnabled: true, cameraEnabled: false, screenShareEnabled: false, e2eeEnabled: true, encrypted: true }], complete: true, e2eeEnabled: true,
    metrics: { rttMs: 23, jitterMs: 2, packetLossPercent: null, sampledTracks: 1, totalTracks: 1 } };
}
async function send(page: Page, value: any, other = false) {
  const owned = page.frames().find(frame => frame.url().includes('telemetry-child?call'))!;
  const document = await owned.evaluate(() => (window as any).telemetryDocument);
  const frame = page.frames().find(frame => frame.url().includes('telemetry-child?' + (other ? 'other' : 'call')))!;
  await frame.evaluate(data => parent.postMessage(data, location.origin), { document, ...value });
}

test('real frame messages require exact widget, room, nonce, source and ordered sequence', async ({ page }) => {
  await fixture(page); await send(page, payload());
  await expect.poll(() => page.evaluate(() => (window as any).updates.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).updates.at(-1).participants[0].displayName)).toBe('Native speaker');
  await send(page, payload(20), true);
  for (const patch of [{ session: 'oldowner-1234-4567-8901-abcdefgh1234' }, { roomId: '!other:local' }, { widgetId: 'oldwidget-1234-4567-8901-abcdefgh1234' }, { sequence: 1 }, { sequence: 0 }, { token: 'forbidden-field' }]) await send(page, { ...payload(22), ...patch });
  await send(page, payload(2));
  await expect.poll(() => page.evaluate(() => (window as any).updates.length)).toBe(3);
  expect(await page.evaluate(() => Object.keys((window as any).updates.at(-1)))).not.toContain('session');
  expect(await page.evaluate(() => (window as any).updates.slice(1).every((item: any) => item.participants[0].identity === 'opaque-native'))).toBe(true);
});

test('same iframe navigated to a foreign origin cannot report telemetry for the previous widget', async ({ page }) => {
  await fixture(page);
  const document = await page.frames().find(frame => frame.url().includes('telemetry-child?call'))!.evaluate(() => (window as any).telemetryDocument);
  await page.locator('#call').evaluate((frame: HTMLIFrameElement) => { frame.src = 'http://foreign.telemetry.invalid/frame'; });
  await expect.poll(() => page.frames().some(frame => frame.url().includes('foreign.telemetry.invalid'))).toBe(true);
  const foreign = page.frames().find(frame => frame.url().includes('foreign.telemetry.invalid'))!;
  await foreign.evaluate(data => parent.postMessage(data, 'http://127.0.0.1:5173'), { ...payload(), document });
  await expect.poll(() => page.evaluate(() => (window as any).messageEvents)).toBe(1);
  expect(await page.evaluate(() => (window as any).updates)).toEqual([null]);
});

test('stale telemetry becomes unavailable and old cleanup cannot replace a newly bound account', async ({ page }) => {
  await page.clock.install(); await fixture(page); await send(page, payload());
  await expect.poll(() => page.evaluate(() => (window as any).updates.length)).toBe(2);
  await page.clock.fastForward(5500); await expect.poll(() => page.evaluate(() => (window as any).updates.at(-1))).toBeNull();
  await send(page, payload(2)); await expect.poll(() => page.evaluate(() => (window as any).updates.at(-1)?.connected)).toBe(true);
  const second = 'newowner-1234-4567-8901-abcdefgh1234';
  await page.evaluate(session => { const w = window as any; w.oldStop = w.telemetryStop; w.owner = {}; w.bind(session); }, second);
  await send(page, payload(100)); await send(page, { ...payload(1), session: second });
  await expect.poll(() => page.evaluate(() => (window as any).updates.at(-1)?.connected)).toBe(true);
  const count = await page.evaluate(() => (window as any).updates.length);
  await page.evaluate(() => (window as any).oldStop()); await page.clock.fastForward(250);
  expect(await page.evaluate(() => (window as any).updates.length)).toBe(count);
  await page.evaluate(() => { (window as any).owner = {}; }); await page.clock.fastForward(250);
  await expect.poll(() => page.evaluate(() => (window as any).updates.at(-1))).toBeNull();
  await send(page, { ...payload(2), session: second }); await page.clock.fastForward(250);
  expect(await page.evaluate(() => (window as any).updates.at(-1))).toBeNull();
});

test('actual iframe reload accepts a new document sequence and rejects queued old-document packets', async ({ page }) => {
  await fixture(page); await send(page, payload(90000));
  await expect.poll(() => page.evaluate(() => (window as any).updates.at(-1)?.connected)).toBe(true);
  const frame = page.frames().find(frame => frame.url().includes('telemetry-child?call'))!;
  const oldDocument = await frame.evaluate(() => (window as any).telemetryDocument);
  await frame.evaluate(() => location.reload());
  await frame.waitForFunction(old => (window as any).telemetryDocument && (window as any).telemetryDocument !== old, oldDocument);
  await expect.poll(() => page.evaluate(() => (window as any).updates.at(-1))).toBeNull();
  const before = await page.evaluate(() => (window as any).updates.length);
  await send(page, { ...payload(90001), document: oldDocument }); await send(page, payload(1));
  await expect.poll(() => page.evaluate(() => (window as any).updates.length)).toBe(before + 1);
  expect(await page.evaluate(() => (window as any).updates.at(-1)?.connected)).toBe(true);
});

test('active fatal evidence remains readable after teardown without retaining stale people or accepting raw errors', async ({ page }) => {
  await page.clock.install(); await fixture(page);
  const failure = { code: 'SFU_ERROR', cause: null, status: null, reason: 'Cancelled', matrixCode: null };
  await send(page, { ...payload(1), failure: { ...failure, stack: 'private details' } });
  await send(page, { ...payload(2), failure });
  await expect.poll(() => page.evaluate(() => (window as any).updates.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).updates.at(-1).failure)).toEqual(failure);
  await page.clock.fastForward(5500);
  const stale = await page.evaluate(() => (window as any).updates.at(-1));
  expect(stale.failure).toEqual(failure); expect(stale.participants).toEqual([]); expect(stale.connected).toBe(false); expect(stale.metrics.rttMs).toBeNull();
  await send(page, payload(3));
  await expect.poll(() => page.evaluate(() => (window as any).updates.at(-1).failure)).toEqual(failure);
  await page.evaluate(() => (window as any).telemetryStop());
  expect(await page.evaluate(() => (window as any).updates.at(-1))).toBeNull();
});
