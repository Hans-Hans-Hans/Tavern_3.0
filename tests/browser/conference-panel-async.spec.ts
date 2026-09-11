import { expect, test, type Page } from '@playwright/test';
import { routeVoiceAvatar } from './voice-fixture-routes';

async function fixture(page: Page) {
  await routeVoiceAvatar(page);
  const requests: { roomId: string; userId: string; confirmation: string }[] = [];
  const responses: ((value: { status?: number; json: object }) => void)[] = [];
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const mutateMatrixAccountData=async()=>{throw new Error("Read-only voice fixture cannot write account data")};export const getMatrixClient=()=>window.audioPanelFixture?.client;export const onMatrixUpdate=fn=>{window.audioPanelFixture.listeners.add(fn);return()=>window.audioPanelFixture.listeners.delete(fn)};' }));
  await page.route(url => url.pathname === '/lib/conference.ts', route => route.fulfill({ contentType: 'text/javascript', body: `
    export async function mountConference(client,roomId,frame,onLeave,signal,onJoined,managed,onDevices){
      const f=window.audioPanelFixture;f.mounts.push(roomId);frame.srcdoc='<p>Isolated media boundary</p>';
      onJoined();onDevices({audio_enabled:true,video_enabled:true});
      const stop=async()=>{f.stops.push(roomId)};
      stop.setDevices=async patch=>{
        const request={roomId,patch,settled:false};f.deviceRequests.push(request);
        try{await new Promise((resolve,reject)=>{request.resolve=resolve;request.reject=()=>reject(new Error('Retired device failure'));});onDevices(patch);}
        finally{request.settled=true;}
      };return stop;
    }` }));
  await page.route('**/api/calls/capabilities', route => route.fulfill({ json: { available: true, audioModerationAvailable: false, audioModerationControls: false } }));
  await page.route('**/api/calls/remove', async route => {
    requests.push(route.request().postDataJSON());
    const response = await new Promise<{ status?: number; json: object }>(resolve => responses.push(resolve));
    await route.fulfill(response);
  });
  await page.route('**/conference-panel-async-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/conference-panel-async.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/conference-panel-async-test');
  await expect(page.getByRole('region', { name: 'Conference in Call room' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mute conference microphone', exact: true })).toBeEnabled();
  return { requests, responses };
}

async function openRemoval(page: Page) {
  await page.getByRole('button', { name: 'Guest', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove from channel and call', exact: true }).click();
  return page.getByRole('alertdialog', { name: 'Remove Guest?' });
}
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }

test('an old device completion cannot unlock or report failure in a replacement call', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Mute conference microphone', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).audioPanelFixture.deviceRequests.length)).toBe(1);
  await page.evaluate(() => (window as any).audioPanelFixture.replaceCall());
  await expect(page.getByRole('region', { name: 'Conference in Other call' })).toBeVisible();
  const button = page.getByRole('button', { name: 'Mute conference microphone', exact: true });
  await expect(button).toBeEnabled(); await button.click();
  await expect.poll(() => page.evaluate(() => (window as any).audioPanelFixture.deviceRequests.length)).toBe(2);
  await page.evaluate(() => (window as any).audioPanelFixture.deviceRequests[0].reject());
  await expect.poll(() => page.evaluate(() => (window as any).audioPanelFixture.deviceRequests[0].settled)).toBe(true);
  await settle(page);
  await expect(button).toBeDisabled(); await expect(page.getByText('Retired device failure', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).audioPanelFixture.deviceRequests[1].resolve());
  await expect(page.getByRole('button', { name: 'Unmute conference microphone', exact: true })).toBeEnabled();
});

test('old removal success cannot close a new call confirmation or clear its pending request', async ({ page }) => {
  const backend = await fixture(page);
  let dialog = await openRemoval(page); await dialog.getByRole('button', { name: 'Remove from channel and call', exact: true }).click();
  await expect.poll(() => backend.requests.length).toBe(1);
  await page.evaluate(() => (window as any).audioPanelFixture.replaceCall());
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  dialog = await openRemoval(page); await dialog.getByRole('button', { name: 'Remove from channel and call', exact: true }).click();
  await expect.poll(() => backend.requests.length).toBe(2);
  const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/calls/remove'));
  backend.responses[0]({ json: { mediaDisconnectConfirmed: true } });
  await (await oldResponse).finished(); await settle(page);
  await expect(dialog.getByRole('button', { name: 'Removing…', exact: true })).toBeDisabled();
  await expect(page.getByText('Removed from the channel and conference.', { exact: true })).toHaveCount(0);
  backend.responses[1]({ json: { mediaDisconnectConfirmed: true } });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Removed from the channel and conference.', { exact: true })).toBeVisible();
  expect(backend.requests).toEqual(['!channel:local', '!other:local'].map(roomId => ({ roomId, userId: '@guest:local', confirmation: 'REMOVE FROM CHANNEL AND CALL' })));
});

for (const kind of ['account', 'actor', 'device', 'room']) test(`a delayed removal refuses a retired ${kind} before sync notification`, async ({ page }) => {
  const backend = await fixture(page);
  const dialog = await openRemoval(page); await dialog.getByRole('button', { name: 'Remove from channel and call', exact: true }).click();
  await expect.poll(() => backend.requests.length).toBe(1);
  // Deliberately do not notify React/native listeners until after the response.
  await page.evaluate(value => (window as any).audioPanelFixture.invalidate(value), kind);
  const response = page.waitForResponse(value => value.url().endsWith('/api/calls/remove'));
  backend.responses[0]({ json: { mediaDisconnectConfirmed: true } });
  await (await response).finished(); await settle(page);
  await expect(page.getByText('Removed from the channel and conference.', { exact: true })).toHaveCount(0);
  expect(backend.requests).toHaveLength(1);
});

test('a confirmation retained before native account drift cannot dispatch removal', async ({ page }) => {
  const backend = await fixture(page), dialog = await openRemoval(page);
  await page.evaluate(() => (window as any).audioPanelFixture.invalidate('actor'));
  await dialog.getByRole('button', { name: 'Remove from channel and call', exact: true }).click();
  expect(backend.requests).toHaveLength(0);
});

test('a current partial removal stays truthful and a current device error remains actionable', async ({ page }) => {
  const backend = await fixture(page);
  await page.getByRole('button', { name: 'Mute conference microphone', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).audioPanelFixture.deviceRequests.length)).toBe(1);
  await page.evaluate(() => (window as any).audioPanelFixture.deviceRequests[0].reject());
  await expect(page.getByText('Retired device failure', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mute conference microphone', exact: true })).toBeEnabled();
  const dialog = await openRemoval(page); await dialog.getByRole('button', { name: 'Remove from channel and call', exact: true }).click();
  await expect.poll(() => backend.requests.length).toBe(1);
  backend.responses[0]({ json: { mediaDisconnectConfirmed: false, message: 'Membership removed; media disconnect is pending.' } });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Membership removed; media disconnect is pending.', { exact: true })).toBeVisible();
  await expect(page.getByText('Removed from the channel and conference.', { exact: true })).toHaveCount(0);
});

test('late device reports cannot change state after account, actor, device, or room retirement', async ({ page }) => {
  for (const kind of ['account', 'actor', 'device', 'room']) {
    await fixture(page);
    const microphone = page.getByRole('button', { name: 'Mute conference microphone', exact: true });
    await microphone.click();
    await expect.poll(() => page.evaluate(() => (window as any).audioPanelFixture.deviceRequests.length)).toBe(1);
    await page.evaluate(value => { const f = (window as any).audioPanelFixture; f.invalidate(value); f.deviceRequests[0].resolve(); }, kind);
    await expect.poll(() => page.evaluate(() => (window as any).audioPanelFixture.deviceRequests[0].settled)).toBe(true);
    await settle(page);
    await expect(microphone).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Unmute conference microphone', exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).audioPanelFixture.notify());
    await expect(page.getByRole('region', { name: /^Conference in/ })).toHaveCount(0);
  }
});
