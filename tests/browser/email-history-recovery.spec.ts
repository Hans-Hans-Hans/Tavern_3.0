import {test,expect,type Page} from '@playwright/test';
async function fixture(page:Page,known=false){
 await page.route(url=>url.pathname==='/lib/api.ts',r=>r.fulfill({contentType:'text/javascript',body:'export const accountArtworkOwner=()=>window.account;export const isManagedAccount=()=>true;'}));
 await page.route(url=>url.pathname==='/lib/matrix.ts',r=>r.fulfill({contentType:'text/javascript',body:'export const getMatrixClient=()=>window.client;'}));
 await page.route(url=>url.pathname==='/lib/email-history.ts',r=>r.fulfill({contentType:'text/javascript',body:`export const emailHistoryStatus=async()=>window.recoveryStatus,hasHistoryLogin=()=>window.hasLogin,autoStartEmailHistory=()=>window.autoStart(),startEmailHistory=async()=>{window.starts++;return 'challenge';},enableEmailHistory=async()=>{},autoEnableEmailHistory=async()=>{},protectCurrentHistory=async()=>{},recoverEmailHistory=async(c,code)=>{if(code!=='123456')throw Error('The verification code is incorrect.');window.unlocks++;window.setKnown(true);};`}));
 await page.route('**/email-history-test*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;await import("/tests/browser/fixtures/email-history-recovery.tsx");</script></body></html>'}));
 await page.goto('/email-history-test'+(known?'?known':''));
}
test('known browsers open without a recovery prompt or email',async({page})=>{
 await fixture(page,true);await expect.poll(()=>page.evaluate(()=>typeof(window as any).setKnown)).toBe('function');
 await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).starts)).toBe(0);
});
test('new device asks for only its email code after password login, retries wrong code and closes after recovery',async({page})=>{
 await page.setViewportSize({width:390,height:700});await fixture(page);
 await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByLabel('Password used to protect history')).toHaveCount(0);
 await page.getByLabel('Email verification code').fill('111111');await page.getByRole('button',{name:'Unlock history',exact:true}).click();await expect(page.getByRole('alert')).toHaveText('The verification code is incorrect.');
 await page.getByLabel('Email verification code').fill('123456');await page.getByRole('button',{name:'Unlock history',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).starts)).toBe(1);expect(await page.evaluate(()=>(window as any).unlocks)).toBe(1);
});
test('a new device can defer recovery without repeating the dialog on ordinary renders',async({page})=>{
 await fixture(page);await page.getByRole('button',{name:'Continue without older history'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.evaluate(()=>(window as any).setKnown(false));await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).starts)).toBe(1);
});
