import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=fn=>{window.listeners.add(fn);return()=>window.listeners.delete(fn);};` }));
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const isManagedAccount=()=>true;export const requestApi=async()=>{window.reads++;if(window.waitNext){window.waitNext=false;await new Promise(resolve=>window.finishRead=resolve);}return structuredClone(window.social);};` }));
  await page.route(url => url.pathname === '/lib/notifications.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const notificationFocusEnabled=()=>false;export const browserNotificationsEnabled=()=>true;export const playNotificationSound=async()=>{window.sounds++;};` }));
  await page.route(url => url.pathname === '/lib/security.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const requestPeerVerification=async()=>{};' }));
  await page.route(url => url.pathname === '/lib/calls.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const callSnapshot=()=>({call:window.call||null,client:window.fixtureClient,media:window.media,error:''});export const subscribeCalls=fn=>{window.callListeners.add(fn);return()=>window.callListeners.delete(fn);};export const answerCall=async()=>{window.answers++;};export const endCall=()=>{window.call.state='ended';window.callListeners.forEach(fn=>fn());};export const callsConfigured=async()=>true;export const startCall=async()=>{};export const toggleCall=async()=>{};export const watchFeed=()=>()=>{};export const setCallMediaSettings=async()=>{};export const setCallTalking=async()=>{};` }));
  await page.route('**/activity-notifications-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/activity-notifications.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/activity-notifications-test');
  await expect.poll(() => page.evaluate(() => (window as any).reads)).toBe(1);
}

test('contact changes deliver one generic alert with a working Contacts action and no baseline replay', async ({ page }) => {
  await fixture(page);
  expect(await page.evaluate(() => (window as any).notices.length)).toBe(0);
  await page.evaluate(() => { const w = window as any; w.social.requests.push({ id: 'new', sender: '@secret-friend:local', target: '@me:local', status: 'pending', created: 2 }); w.emitContacts(); w.emitContacts(); });
  await expect(page.getByText('You have a new friend request.', { exact: true })).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as any).notices.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).notices[0].options)).toEqual({ body: 'You have a new friend request.', tag: 'tavern:friend', silent: true });
  await page.getByRole('button', { name: 'View requests', exact: true }).click();
  expect(await page.evaluate(() => (window as any).contactsOpened)).toBe(true);
  expect(await page.evaluate(() => (window as any).notices[0].closed)).toBe(true);
});

test('incoming call alerts expand the existing minimized call panel without answering and close on hangup', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => (window as any).ring('call-one'));
  await expect(page.getByRole('button', { name: 'Show call', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Minimize call', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Answer with audio', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Show call', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Answer with audio', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).answers)).toBe(0);
  await page.evaluate(() => { const w = window as any; w.callListeners.forEach((fn: any) => fn()); });
  expect(await page.evaluate(() => (window as any).notices.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).notices[0].options.body)).toBe('You have an incoming call.');
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(page.getByText('You have an incoming call.', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).notices[0].closed)).toBe(true);
});

test('DND and blocked users suppress alerts, and logout closes the stream and drops pending responses', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const w = window as any; w.accounts['io.tavern.presence'] = { mode: 'dnd' }; w.ring('quiet'); w.social.requests.push({ id: 'quiet', sender: '@secret-friend:local', target: '@me:local', status: 'pending', created: 2 }); w.emitContacts(); });
  await expect.poll(() => page.evaluate(() => (window as any).reads)).toBe(2);
  expect(await page.evaluate(() => (window as any).notices.length)).toBe(0);
  await page.evaluate(() => { const w = window as any; w.accounts['io.tavern.presence'] = { mode: 'online' }; w.ignored = ['@private-caller:local']; w.ring('blocked'); w.waitNext = true; w.emitContacts(); });
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishRead)).toBe('function');
  await page.evaluate(() => { const w = window as any; window.dispatchEvent(new Event('tavern:signout')); w.social.requests.push({ id: 'late', sender: '@later:local', target: '@me:local', status: 'pending', created: 3 }); w.finishRead(); });
  expect(await page.evaluate(() => (window as any).streams.every((stream: any) => stream.closed))).toBe(true);
  expect(await page.evaluate(() => (window as any).notices.length)).toBe(0);
});
