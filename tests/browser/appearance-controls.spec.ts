import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: `
    const updates=new Set(),accounts={A:{theme:'light'},B:{theme:'dark',density:'comfortable',messageSpacing:'comfortable'}};
    let hold=false,finish;const make=id=>({getUserId:()=> '@'+id+':local',getDeviceId:()=>id,
      getAccountData:()=>({getContent:()=>accounts[id]}),getAccountDataFromServer:async()=>accounts[id],
      setAccountData:async(key,value)=>{if(hold)await new Promise((resolve,reject)=>{finish=fail=>fail?reject(Error('Old save failed')):resolve()});accounts[id]=value;},on:()=>{},off:()=>{}});
    let client=make('A');export const getMatrixClient=()=>client;export const onMatrixUpdate=fn=>{updates.add(fn);return()=>updates.delete(fn)};
    window.appearanceFixture={accounts,hold:()=>{hold=true;},pending:()=>!!finish,release:fail=>{hold=false;finish(fail);},
      switchAccount:async(silent=false)=>{client=make('B');const api=await import('/lib/api.ts');api.setAccountDevice('B');const appearance=await import('/lib/appearance.ts');appearance.initializeAppearance(client);if(!silent)updates.forEach(fn=>fn());},
      reset:async()=>{const appearance=await import('/lib/appearance.ts');appearance.resetAppearance();appearance.initializeAppearance(client);updates.forEach(fn=>fn());}};
  ` }));
  await page.route('**/appearance-controls-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name='viewport' content='width=device-width, initial-scale=1'></head><body><div id='root'></div><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/appearance-settings.tsx')).mountFixture();</script></body></html>` }));
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/appearance-controls-test');
  await expect(page.getByRole('combobox', { name: 'Interface density' })).toBeVisible();
}
for (const width of [390, 1100]) test(`density and independent message spacing persist and fit at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 }); await fixture(page);
  const sample=page.getByTestId('spacing-sample'), density=page.getByRole('combobox', { name: 'Interface density' }), spacing=page.getByRole('combobox', { name: 'Message spacing' });
  await expect(sample).toHaveCSS('padding-top', '5px');
  await density.selectOption('compact'); await expect(density).toBeEnabled();
  await expect(page.getByRole('button', { name: 'A channel', exact: true })).toHaveCSS('min-height', '32px');
  await spacing.selectOption('spacious'); await expect(spacing).toBeEnabled();
  await expect(sample).toHaveCSS('padding-top', '18px'); await expect(page.locator('.appearance-message-preview .message').first()).toHaveCSS('padding-top', '18px');
  await expect(page.locator('html')).toHaveCSS('--tavern-chat-scale', '1');
  await page.evaluate(()=> (window as any).appearanceFixture.reset());
  await expect(density).toHaveValue('compact'); await expect(spacing).toHaveValue('spacious'); await expect(sample).toHaveCSS('padding-top', '18px');
  const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth); expect(fits).toBe(true);
  await spacing.selectOption('auto'); await expect(sample).toHaveCSS('padding-top', '5px');
});
for (const fail of [false,true]) test(`a delayed ${fail?'failed':'successful'} save cannot replace a new account's settings`, async ({ page }) => {
  await fixture(page); await page.evaluate(()=> (window as any).appearanceFixture.hold());
  await page.getByRole('combobox', { name: 'Interface density' }).selectOption('compact');
  await page.waitForFunction(()=> (window as any).appearanceFixture.pending());
  await page.evaluate(()=> (window as any).appearanceFixture.switchAccount());
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.getByRole('combobox', { name: 'Interface density' })).toHaveValue('comfortable');
  await page.evaluate(fail=> (window as any).appearanceFixture.release(fail), fail);
  await page.waitForTimeout(80);
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.locator('html')).toHaveAttribute('data-density','comfortable');
  await expect(page.getByRole('combobox', { name: 'Interface density' })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test.describe('touch navigation',()=>{
  test.use({hasTouch:true});
  test('compact density keeps a 44px touch target',async({page})=>{
    await page.setViewportSize({width:390,height:800});await fixture(page);
    await page.getByRole('combobox',{name:'Interface density'}).selectOption('compact');
    await expect(page.getByRole('button',{name:'A channel',exact:true})).toHaveCSS('min-height','44px');
  });
});

for(const name of ['Chat text size','Interface color saturation'])test(`stale ${name} preview cannot restyle a replacement account before a UI update`,async({page})=>{
  await fixture(page);await page.evaluate(()=>(window as any).appearanceFixture.switchAccount(true));
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.getByRole('slider',{name,exact:true}).focus();await page.keyboard.press('ArrowLeft');
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.locator('html')).toHaveCSS('--tavern-chat-scale','1');
  await expect(page.getByRole('combobox',{name:'Interface density'})).toHaveValue('comfortable');
  expect(await page.evaluate(()=>(window as any).appearanceFixture.accounts.B)).toEqual({theme:'dark',density:'comfortable',messageSpacing:'comfortable'});
});

test('the application entry applies saved density and spacing before opening settings',async({page})=>{
  let settingsRequests=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/app/appearance-settings.tsx')settingsRequests++;});
  await page.route(url=>url.pathname==='/lib/matrix.ts',route=>route.fulfill({contentType:'text/javascript',body:`const saved={density:'compact',messageSpacing:'spacious'};const client={getAccountData:()=>({getContent:()=>saved}),on:()=>{},off:()=>{}};export const getMatrixClient=()=>client;`}));
  await page.route(url=>url.pathname==='/app/auth-gateway.tsx',route=>route.fulfill({contentType:'text/javascript',body:`import React from '/node_modules/.vite/deps/react.js';export const AuthGateway=()=>React.createElement('main',null,React.createElement('button',{className:'channel-link'},'A channel'),React.createElement('div',{className:'message compact'},'Existing message'));`}));
  await page.route(url=>url.pathname==='/app/pwa-status.tsx',route=>route.fulfill({contentType:'text/javascript',body:`export const PwaStatus=()=>null;`}));
  await page.route('**/appearance-startup-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><div id='root'></div><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/app/main.tsx');const appearance=await import('/lib/appearance.ts');appearance.initializeAppearance(appearance.appearanceOwner().client);</script></body></html>`}));
  await page.goto('/appearance-startup-test');
  await expect(page.locator('.message')).toHaveCSS('padding-top','18px');
  await expect(page.getByRole('button',{name:'A channel'})).toHaveCSS('min-height','32px');
  expect(settingsRequests).toBe(0);
});
