import { test, expect } from '@playwright/test';
test('quick switcher searches rooms, runs commands, and restores keyboard focus', async ({ page }) => {
  page.on('pageerror', error => console.error('Command fixture:', error.message));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const getMatrixClient=()=>({getRooms:()=>[{roomId:'!project:local',name:'Project launch',isSpaceRoom:()=>false,getMyMembership:()=> 'join'},{roomId:'!gaming:local',name:'Gaming server',isSpaceRoom:()=>true,getMyMembership:()=> 'join'}]});` }));
  await page.route('**/command-component-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><button id="opener">Open switcher</button><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    (await import('/tests/browser/fixtures/command-palette.tsx')).mountFixture();
  </script></body></html>` }));
  await page.goto('/command-component-test');
  await page.waitForFunction(() => (window as any).fixtureReady === true);
  await page.getByRole('button', { name: 'Open switcher' }).focus();
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox'); await expect(input).toBeVisible(); await input.fill('project'); await expect(input).toHaveValue('project'); await expect(page.getByRole('option', { name: 'Gaming server' })).toHaveCount(0); await input.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(await page.evaluate(() => (window as any).chosen)).toEqual(['room:!project:local']);
  await expect(page.getByRole('button', { name: 'Open switcher' })).toBeFocused();
  await page.keyboard.press('Control+Shift+p'); await expect(input).toBeVisible(); await input.fill('appearance'); await expect(input).toHaveValue('appearance'); await expect(page.getByRole('option', { name: 'Appearance and theme' })).toBeVisible(); await input.press('Enter');
  expect(await page.evaluate(() => (window as any).chosen)).toEqual(['room:!project:local', 'settings:appearance']);
  await page.getByRole('button', { name: 'Open switcher' }).click(); await expect(input).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Open switcher' })).toBeFocused();
});

test('palette finds cached people by nickname and applies authenticated status commands', async ({ page }) => {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: `const client={getUserId:()=> '@me:local',getRooms:()=>[{roomId:'!room:local',name:'Project',isSpaceRoom:()=>false,getMyMembership:()=> 'join',getJoinedMembers:()=>[{userId:'@alice:local',name:'Captain Alice',membership:'join'},{userId:'@me:local',name:'Me',membership:'join'}]}],setPresence:async v=>{window.presence=v;},setSyncPresence:async v=>{window.syncPresence=v;},setAccountData:async(k,v)=>{window.presenceAccount={key:k,value:v};}};export const getMatrixClient=()=>client;` }));
  await page.route('**/command-people-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><button id="opener">Open switcher</button><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/command-palette.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/command-people-test'); await page.waitForFunction(() => (window as any).fixtureReady === true); await page.getByRole('button', { name: 'Open switcher' }).click(); const input = page.getByRole('combobox'); await input.fill('@captain'); await expect(page.getByRole('option', { name: 'Captain Alice @alice:local' })).toBeVisible(); await input.press('Enter'); await expect.poll(() => page.evaluate(() => (window as any).chosen)).toEqual(['dm:@alice:local']);
  await page.getByRole('button', { name: 'Open switcher' }).click(); await input.fill('/status dnd'); await expect(page.getByRole('option', { name: 'Set status: Do not disturb' })).toBeVisible(); await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).presenceAccount)).toEqual({ key: 'io.tavern.presence', value: { mode: 'dnd' } }); expect(await page.evaluate(() => (window as any).presence)).toEqual({ presence: 'online', status_msg: 'Do not disturb' });
});
