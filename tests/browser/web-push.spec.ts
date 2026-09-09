import { test, expect, type Page, type BrowserContext, type Worker } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

async function fixture(page: Page, context: BrowserContext) {
  const key = new Uint8Array(65); key[0] = 4;
  const backend = { binding: null as any, generation: 'a'.repeat(32), show: true, checks: 0, checkGate: null as Promise<void> | null, deleteFails: false, foreground: [] as any[], providerActive: false, unsubscribed: 0 };
  const workerSource = readFileSync('scripts/service-worker.js', 'utf8').replace('__TAVERN_BUILD__', 'browser-push-test').replace('__TAVERN_STATIC_FILES__', '[]');
  await context.grantPermissions(['notifications']);
  await context.route('**/sw.js', route => route.fulfill({ contentType: 'application/javascript', body: workerSource }));
  await context.route('**/fixture-push-provider', route => { if (route.request().method() === 'POST') backend.providerActive = true; if (route.request().method() === 'DELETE') { backend.providerActive = false; backend.unsubscribed++; } return route.fulfill({ json: { active: backend.providerActive } }); });
  await context.route('**/api/push/**', async route => {
    const request = route.request();
    if (request.url().endsWith('/bind')) { const binding = backend.binding; return route.fulfill({ json: binding?.generation === request.postDataJSON().generation ? { valid: true, generation: binding.generation, expiresAt: binding.expiresAt } : { valid: false } }); }
    if (request.url().endsWith('/foreground')) { backend.foreground.push(request.postDataJSON()); return route.fulfill({ json: { ok: true, expiresAt: request.postDataJSON().active ? Date.now() + 35000 : 0 } }); }
    if (request.url().endsWith('/check')) { backend.checks++; if (backend.checkGate) await backend.checkGate; return route.fulfill({ json: { show: backend.show } }); }
    if (request.url().endsWith('/config')) return route.fulfill({ json: { enabled: true, publicKey: Buffer.from(key).toString('base64url'), subscription: backend.binding } });
    if (request.method() === 'DELETE') { if (backend.deleteFails) return route.fulfill({ status: 502, json: { error: 'Cleanup fixture unavailable' } }); backend.binding = null; return route.fulfill({ json: { ok: true } }); }
    const subscription = request.postDataJSON().subscription;
    backend.binding = { id: 'fixture-record', generation: backend.generation, expiresAt: Date.now() + 60000, subscriptionHash: createHash('sha256').update(JSON.stringify([subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth])).digest('hex') };
    return route.fulfill({ json: backend.binding });
  });
  await context.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export async function requestApi(path,body,method=body===undefined?'GET':'POST'){const response=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data}` }));
  await context.route('**/web-push-test*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/web-push.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/web-push-test?invite=preserve-me'); await page.waitForFunction(() => (window as any).fixtureReady);
  await expect(page.getByRole('button', { name: 'Enable background notifications', exact: true })).toBeEnabled();
  const worker = context.serviceWorkers()[0];
  // Chromium headless accepts showNotification but need not retain OS notices.
  // Observe the native call after it resolves; do not replace browser delivery.
  await worker.evaluate(() => { const original = (self as any).registration.showNotification.bind((self as any).registration); (self as any).deliveredNotices = []; (self as any).registration.showNotification = async (title: string, options: any) => { await original(title, options); (self as any).deliveredNotices.push({ title, ...options }); }; });
  const notices = () => worker.evaluate(() => (self as any).deliveredNotices);
  return { backend, worker, notices };
}
async function push(worker: Worker, generation: string) {
  await worker.evaluate(value => { (self as any).dispatchEvent(new (self as any).PushEvent('push', { data: JSON.stringify({ v: 1, kind: 'activity', generation: value, ticket: 't'.repeat(32), expiresAt: Date.now() + 30000 }) })); }, generation);
}

test('explicit consent binds a real worker and generic notices preserve an existing deep link', async ({ page, context }) => {
  const f = await fixture(page, context);
  expect(await page.evaluate(() => [(window as any).permissionCalls, (window as any).subscriptionCalls])).toEqual([0, 0]);
  await page.getByRole('button', { name: 'Enable background notifications', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Enabled for this account session and browser.');
  await push(f.worker, f.backend.generation);
  await expect.poll(f.notices).toHaveLength(1);
  expect((await f.notices())[0]).toEqual({ title: 'Tavern', body: 'You have new activity in Tavern.', tag: 'tavern-background', silent: true, data: { generation: f.backend.generation } });
  await f.worker.evaluate(async () => { const notice = (self as any).deliveredNotices[0], pending: Promise<unknown>[] = []; const event = new Event('notificationclick'); Object.defineProperties(event, { notification: { value: { ...notice, close() { (self as any).noticeClosed = true; } } }, waitUntil: { value: (promise: Promise<unknown>) => pending.push(promise) } }); (self as any).dispatchEvent(event); await Promise.all(pending); });
  expect(await f.worker.evaluate(() => (self as any).noticeClosed)).toBe(true); expect(page.url()).toContain('?invite=preserve-me');
  await page.getByRole('button', { name: 'Turn off background notifications', exact: true }).click(); await expect(page.getByRole('status')).toHaveText('Background notifications are off.');
});

test('responsive SDK clients deduplicate push and logout fences an outstanding native-worker delivery check', async ({ page, context }) => {
  const f = await fixture(page, context); await page.getByRole('button', { name: 'Enable background notifications', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Enabled');
  await page.evaluate(() => (window as any).setSdkHandles(true)); await expect.poll(() => f.backend.foreground.length).toBe(1); expect(f.backend.foreground[0]).toMatchObject({ active: true, generation: f.backend.generation, sequence: 1 });
  await push(f.worker, f.backend.generation); await expect.poll(() => f.backend.checks).toBe(1); await page.waitForTimeout(1200); expect(await f.notices()).toEqual([]);
  await page.evaluate(() => (window as any).setSdkHandles(false)); await expect.poll(() => f.backend.foreground.at(-1).active).toBe(false);
  let release!: () => void; f.backend.checkGate = new Promise(resolve => { release = resolve; }); await push(f.worker, f.backend.generation); await expect.poll(() => f.backend.checks).toBe(2);
  await page.evaluate(() => (window as any).stopOwner()); release(); await page.waitForTimeout(1200); expect(await f.notices()).toEqual([]);
  await expect(page.getByRole('status')).toHaveText('Background notifications are off.');
});

test('failed server cleanup stays visibly off with a working retry action', async ({ page, context }) => {
  const f = await fixture(page, context); await page.getByRole('button', { name: 'Enable background notifications', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Enabled');
  f.backend.deleteFails = true; await page.getByRole('button', { name: 'Turn off background notifications', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Server cleanup may need a retry');
  await expect(page.getByRole('status')).toHaveText('Background notifications are off.');
  f.backend.deleteFails = false; await page.getByRole('button', { name: 'Retry notification cleanup', exact: true }).click(); await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => f.backend.binding).toBeNull();
});

test('two real tabs preserve B against stale A binding, disable, logout and in-flight clear', async ({ page, context }) => {
  const f = await fixture(page, context); await page.getByRole('button', { name: 'Enable background notifications', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Enabled');
  const old = { ...f.backend.binding };
  f.backend.binding = null; f.backend.generation = 'b'.repeat(32);
  const second = await context.newPage(); await second.goto('/web-push-test?second-tab'); await second.waitForFunction(() => (window as any).fixtureReady);
  await expect(second.getByRole('button', { name: 'Enable background notifications', exact: true })).toBeEnabled();
  await second.getByRole('button', { name: 'Enable background notifications', exact: true }).click(); await expect(second.getByRole('status')).toContainText('Enabled');
  const send = (data: object) => page.evaluate(async payload => { const channel = new MessageChannel(); const reply = new Promise(resolve => { channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); }; }); navigator.serviceWorker.controller!.postMessage(payload, [channel.port2]); return await reply; }, data);
  expect(await send({ type: 'TAVERN_PUSH_BIND', generation: old.generation, expiresAt: old.expiresAt, device: 'fixture-A', restore: true })).toMatchObject({ ok: false });
  await page.getByRole('button', { name: 'Turn off background notifications', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Another Tavern tab');
  expect(f.backend.providerActive).toBe(true); expect(f.backend.unsubscribed).toBe(0);
  await page.evaluate(() => (window as any).stopOwner());
  let release!: () => void; f.backend.checkGate = new Promise(resolve => { release = resolve; }); await push(f.worker, f.backend.generation); await expect.poll(() => f.backend.checks).toBe(1);
  expect(await send({ type: 'TAVERN_PUSH_CLEAR', generation: old.generation })).toMatchObject({ ok: true, cleared: false });
  release(); await expect.poll(f.notices).toHaveLength(1);
  expect((await f.notices())[0].data.generation).toBe(f.backend.generation); expect(f.backend.providerActive).toBe(true); expect(f.backend.unsubscribed).toBe(0);
  await second.evaluate(() => (window as any).stopOwner()); await second.close();
});
