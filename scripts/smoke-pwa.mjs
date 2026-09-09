// Production-worker smoke test; API fixtures contain no real accounts or credentials.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const origin = 'http://127.0.0.1:4174';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4174', '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let logs = ''; server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
let browser, page;
try {
  const deadline = Date.now() + 20000;
  while (true) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    if (Date.now() > deadline || server.exitCode !== null) throw new Error('Production preview did not start.\n' + logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const context = await browser.newContext(); page = await context.newPage();
  page.on('pageerror', error => { logs += '\nBrowser error: ' + error.message; });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ status: path === '/api/auth/session' ? 401 : 200, contentType: 'application/json', body: JSON.stringify(path === '/api/auth/config' ? { bootstrapRequired: false, smtpConfigured: false } : path === '/api/system/status' ? { maintenance: { enabled: false } } : { error: 'Not signed in' }) });
  });
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor();
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.active, undefined, { timeout: 30000 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect(page.getByText('An app update is ready', { exact: true })).toHaveCount(0);
  const stored = await page.evaluate(async () => {
    const result = [];
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) result.push(new URL(request.url).pathname);
    return result;
  });
  assert.ok(stored.includes('/index.html')); assert.ok(stored.includes('/tavern-icon-512.png'));
  assert.ok(stored.every(path => path.startsWith('/assets/') || ['/index.html', '/manifest.webmanifest', '/favicon.svg', '/tavern-icon.svg', '/tavern-icon-192.png', '/tavern-icon-512.png', '/tavern-icon-maskable.png'].includes(path)));
  assert.ok(!stored.some(path => path.startsWith('/api/') || path.includes('tavern-config')));
  await page.unrouteAll(); await context.setOffline(true); await page.reload();
  await page.getByText('You’re offline', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Unable to connect', exact: true }).waitFor();
  assert.ok(await page.locator('#root').innerText());
  console.log('PASS: production PWA installs, caches only static assets, and opens its reconnect screen offline.');
} catch (error) { console.error(logs); if (page) { console.error('Offline page:', await page.locator('body').innerText().catch(() => 'unavailable')); console.error('Browser network:', await page.evaluate(() => ({ online: navigator.onLine, controlled: !!navigator.serviceWorker.controller }))); } throw error; }
finally { await browser?.close(); server.kill(); }
