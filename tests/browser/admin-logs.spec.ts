import { test, expect } from '@playwright/test';

test('logs filters and exported snapshot preserve measured unavailable states', async ({ page }) => {
  const requests: URL[] = [];
  const snapshot = { available: true, rows: [{ timestamp: '2026-09-09T00:00:00Z', component: 'tavern-api', severity: 'ERROR', message: 'Database unavailable; access_token=[redacted]' }], components: ['tavern-api'], unavailable: [], capturedAt: '2026-09-09T00:00:01Z', truncated: true };
  await page.route('**/api/admin/logs?*', route => { requests.push(new URL(route.request().url())); return route.fulfill({ json: snapshot }); });
  await page.route('**/api/admin/performance', route => route.fulfill({ json: { available: true, components: [{ component: 'tavern-api', state: 'running', available: true, cpuPercent: null, memoryBytes: null, pids: null, receivedBytes: null, sentBytes: null }], operationQueueDepth: 1, capturedAt: '2026-09-09T00:00:01Z' } }));
  await page.route('**/admin-logs-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/admin-logs.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/admin-logs-test');
  await expect(page.getByRole('region', { name: 'Service log results' })).toContainText('access_token=[redacted]');
  const sample = page.locator('.admin-resource-table tbody tr');
  await expect(sample).toContainText('Unavailable'); await expect(sample).not.toContainText('0.0%');
  await page.getByLabel('Component', { exact: true }).selectOption('tavern-api');
  await page.getByLabel('Severity', { exact: true }).selectOption('ERROR');
  await page.getByLabel('Time window', { exact: true }).selectOption('60');
  await page.getByLabel('Search message', { exact: true }).fill('Database');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(Object.fromEntries(requests[1].searchParams)).toEqual({ component: 'tavern-api', severity: 'ERROR', minutes: '60', limit: '200', search: 'Database' });
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export this snapshot', exact: true }).click();
  const stream = await (await download).createReadStream(); const chunks = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString()).rows).toEqual(snapshot.rows);
});
