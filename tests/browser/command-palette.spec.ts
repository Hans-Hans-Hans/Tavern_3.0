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
