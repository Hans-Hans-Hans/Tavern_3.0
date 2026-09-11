import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, mode = '') {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const mutateMatrixAccountData=()=>{throw new Error("Unexpected navigation account-data write in server-defaults fixture");};export const getMatrixClient=()=>window.fixtureClient;export const onMatrixUpdate=fn=>{window.listeners.push(fn);return()=>{};};export const matrixApi=async(action,value)=>{window.actions.push([action,value]);return {id:'!created:local'};};` }));
  await page.route(url => url.pathname === '/lib/notifications.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const synchronizeNotificationRules=async()=>{};export const browserNotificationsEnabled=()=>false;export const disableBrowserNotifications=()=>{};export const enableBrowserNotifications=async()=>{};export const playNotificationSound=async()=>{};export const notificationDefaultsSyncError=()=>'';` }));
  await page.route(url => url.pathname === '/app/community-settings.tsx', route => route.fulfill({ contentType: 'text/javascript', body: 'export const ServerWelcome=()=>null;' }));
  await page.route('**/server-defaults-test*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/server-defaults.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/server-defaults-test?' + mode);
}

test('server defaults and welcome channels save actual state with revision checks', async ({ page }) => {
  await fixture(page);
  await page.getByRole('combobox', { name: 'Default notifications', exact: true }).selectOption('nothing');
  await page.getByRole('button', { name: 'Save notification default', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Notification default saved.');
  await page.getByRole('combobox', { name: 'Rules channel', exact: true }).selectOption('!rules:local');
  await page.getByRole('combobox', { name: 'Welcome channel', exact: true }).selectOption('!general:local');
  await page.getByRole('combobox', { name: 'Announcement channel', exact: true }).selectOption('!rules:local');
  await page.getByRole('button', { name: 'Save welcome experience', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).writes.length)).toBe(2);
  const writes = await page.evaluate(() => (window as any).writes);
  expect(writes[0][2]).toEqual({ version: 1, mode: 'nothing', 'io.tavern.previous_event': '$io.tavern.notification.defaults:0' });
  expect(writes[1][2].rulesChannel).toBe('!rules:local'); expect(writes[1][2].welcomeChannel).toBe('!general:local');
  expect(writes[1][2].announcementChannel).toBe('!rules:local');
});

test('settings hide without custom authority and reject permissions removed while saving', async ({ page }) => {
  await fixture(page, 'restricted');
  await expect(page.getByRole('button', { name: 'Save welcome experience' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save notification default' })).toHaveCount(0);
  await fixture(page);
  await page.evaluate(() => { const w = window as any; w.beforeRead = () => { w.server.power.users[w.actor] = 0; w.beforeRead = null; }; });
  await page.getByRole('button', { name: 'Save welcome experience', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Permissions or memberships changed');
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
});

test('creation submits welcome and notification choices and welcome rules links join the actual channel', async ({ page }) => {
  await fixture(page, 'create');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Gaming');
  await page.getByRole('combobox', { name: 'Default notifications' }).selectOption('all');
  await page.getByRole('textbox', { name: 'Welcome message' }).fill('Welcome to Gaming!');
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).created)).toBe('!created:local');
  const actions = await page.evaluate(() => (window as any).actions);
  expect(actions[0]).toEqual(['createServer', { name: 'Gaming', description: '', notificationMode: 'all', welcome: 'Welcome to Gaming!', welcomeEnabled: true }]);
  await fixture(page, 'welcome');
  await page.getByRole('button', { name: 'Read the rules: Rules', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).selected)).toBe('!rules:local');
  expect(await page.evaluate(() => (window as any).actions)).toEqual([['join', { id: '!rules:local' }]]);
  expect(await page.evaluate(() => (window as any).accounts['io.tavern.server_welcome']['!server:local'].completed)).toBe(true);
  await fixture(page, 'welcome');
  await page.getByRole('button', { name: 'Announcements: Rules', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).selected)).toBe('!rules:local');
  expect(await page.evaluate(() => (window as any).actions)).toEqual([['join', { id: '!rules:local' }]]);
});

test('choosing a personal global notification mode opts out of community defaults', async ({ page }) => {
  await fixture(page, 'personal');
  const defaults = page.getByRole('checkbox', { name: 'Use server and channel defaults unless I choose a personal override' });
  await expect(defaults).toBeChecked();
  await page.getByRole('combobox', { name: 'Notify me about', exact: true }).selectOption('nothing');
  await expect(defaults).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).accounts['io.tavern.notification_preferences'].global.mode)).toBe('nothing');
});
