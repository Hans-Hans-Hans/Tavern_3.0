import {test,expect, type Page} from '@playwright/test';
async function setup(page: Page, query = '') {
  page.on('pageerror', error=>console.error('Welcome fixture:',error.message));
  await page.route(url=>url.pathname==='/lib/matrix.ts',route=>route.fulfill({contentType:'text/javascript',body:`window.welcomeRecords={};window.welcomeSynced=!location.search.includes('delayed');const listeners=new Set();window.welcomeSync=(value)=>{if(value)window.welcomeRecords['io.tavern.onboarding']=value;window.welcomeSynced=true;listeners.forEach(fn=>fn());};const client={isInitialSyncComplete:()=>window.welcomeSynced,getAccountData:key=>({getContent:()=>window.welcomeRecords[key]}),setAccountData:async(key,value)=>{window.welcomeRecords[key]=value;listeners.forEach(fn=>fn());}};export const getMatrixClient=()=>client;export const onMatrixUpdate=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};`}));
  await page.route(url=>url.pathname==='/lib/community.ts',route=>route.fulfill({contentType:'text/javascript',body:`export const readOwnProfile=()=>({name:'Alice',avatar:'',status:'',timezone:'UTC',language:'en'});export const saveOwnProfile=async value=>{window.savedProfile=value};`}));
  await page.route(url=>url.pathname==='/app/community-settings.tsx',route=>route.fulfill({contentType:'text/javascript',body:`export const ImageEditor=()=>null;`}));
  await page.route('**/welcome-component-test*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'></head><body><button id='reopen'>Resume tour</button><div id='root'></div><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/welcome.tsx')).mountFixture();window.welcomeReady=true;</script></body></html>`}));
  await page.goto('/welcome-component-test' + query); await page.waitForFunction(() => (window as any).welcomeReady);
}
test('welcome tour saves progress, preserves it when dismissed, and resumes from settings',async({page})=>{
  await setup(page);await page.getByRole('button',{name:'Set up my profile'}).click();await page.getByLabel('Display name',{exact:true}).fill('Alice Changed');await page.getByRole('button',{name:'Save and continue'}).click();
  await expect(page.getByRole('heading',{name:'Find your people'})).toBeVisible();expect(await page.evaluate(()=>(window as any).savedProfile.name)).toBe('Alice Changed');
  await page.getByRole('button',{name:'Finish later'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).welcomeRecords['io.tavern.onboarding'])).toEqual({version:1,step:2,completed:true});
  await page.getByRole('button',{name:'Resume tour'}).click();await expect(page.getByRole('heading',{name:'Find your people'})).toBeVisible();await page.getByRole('button',{name:'Continue to the tour'}).click();await page.getByRole('button',{name:'Start using Tavern'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a completed tour stays closed when saved account data arrives after mounting', async ({page}) => {
  await setup(page, '?delayed'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => (window as any).welcomeSync({version:1,step:2,completed:true}));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Resume tour'}).click();
  await expect(page.getByRole('heading',{name:'Find your people'})).toBeVisible();
  await page.evaluate(() => (window as any).welcomeSync());
  await expect(page.getByRole('heading',{name:'Find your people'})).toBeVisible();
});

test('a new account opens its tour only after initial sync and honors completion from another device', async ({page}) => {
  await setup(page, '?delayed'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => (window as any).welcomeSync());
  await expect(page.getByRole('heading',{name:'Welcome to Tavern'})).toBeVisible();
  await page.evaluate(() => (window as any).welcomeSync({version:1,step:3,completed:true}));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
