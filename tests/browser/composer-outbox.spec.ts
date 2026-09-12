import {expect,test,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
const exports=[...readFileSync('lib/matrix.ts','utf8').matchAll(/export (?:async )?function (\w+)/g)].map(match=>match[1]);
async function fixture(page:Page){
  await page.route(url=>url.pathname==='/lib/matrix.ts',route=>route.fulfill({contentType:'text/javascript',body:exports.map(name=>'export const '+name+'=(...args)=>window.matrixBoundary('+JSON.stringify(name)+',args);').join('\n')}));
  await page.route('**/config.json',route=>route.fulfill({json:{homeserverUrl:'http://127.0.0.1:5173',serverRolePolicy:true,callsEnabled:false}}));
  await page.route('**/composer-outbox-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await (await import("/tests/browser/fixtures/composer-outbox.tsx")).mountFixture();</script></body></html>'}));
  await page.goto('/composer-outbox-test');await page.waitForFunction(()=>(window as any).outboxReady);await expect(page.getByRole('textbox',{name:'Message Source',exact:true})).toBeEnabled();
}
const composer=(page:Page)=>page.locator('.composer-wrap').first(),panel=(page:Page)=>page.locator('#outbox-fixture');
const attach=(page:Page)=>composer(page).locator('input[type=file]').setInputFiles({name:'private.txt',mimeType:'text/plain',buffer:Buffer.from('private attachment bytes')});
test('failed attachment send transfers to encrypted Outbox and survives composer navigation before explicit retry',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await fixture(page);await composer(page).getByRole('textbox').fill('Original caption');await attach(page);
  await expect(composer(page).getByLabel('Remove private.txt')).toBeVisible();await composer(page).getByRole('button',{name:'Send message',exact:true}).click();
  await expect(composer(page)).toContainText('Saved unsent in Outbox');await expect(composer(page).getByRole('textbox')).toHaveValue('');
  await expect(panel(page)).toContainText('Uploaded; message not acknowledged');await expect(panel(page)).toContainText('Original caption');
  await page.getByRole('button',{name:'Direct messages',exact:true}).click();await page.locator('.dm-section .dm-link').filter({hasText:'Guest'}).click();await expect(page.getByRole('textbox',{name:'Message Guest',exact:true})).toHaveValue('');
  await page.evaluate(async()=>{(window as any).failDelivery=false;await (window as any).reopenOutbox();});
  await expect(panel(page)).toContainText('private.txt');await panel(page).getByRole('button',{name:'Retry delivery',exact:true}).click();
  await expect(panel(page)).toContainText('No pending messages');
  const sent=await page.evaluate(()=>(window as any).deliveries);expect(sent).toHaveLength(2);expect(sent[1].transaction).toBe(sent[0].transaction);expect(sent[1].descriptor.file).toEqual(sent[0].descriptor.file);expect(errors).toEqual([]);
});
test('a failed raw upload parks encrypted file bytes without sending or consuming the caption',async({page})=>{
  await fixture(page);await page.evaluate(()=>(window as any).failUpload=true);await composer(page).getByRole('textbox').fill('Caption remains here');await attach(page);
  await expect(composer(page)).toContainText('file only; message text stays in the composer');await expect(composer(page).getByRole('textbox')).toHaveValue('Caption remains here');await expect(panel(page)).toContainText('Saved on this device; upload pending');
  expect(await page.evaluate(()=>(window as any).deliveries.length)).toBe(0);
  await page.evaluate(()=>{(window as any).failUpload=false;(window as any).failDelivery=false;});await panel(page).getByRole('button',{name:'Retry delivery',exact:true}).click();
  await expect(panel(page)).toContainText('No pending messages');await expect(composer(page).getByRole('textbox')).toHaveValue('Caption remains here');
});
test('stale delivery responses do not clear a replacement composer draft',async({page})=>{
  await fixture(page);await page.evaluate(()=>{(window as any).deferDelivery=true;(window as any).failDelivery=false;});await attach(page);await composer(page).getByRole('textbox').fill('Old caption');await composer(page).getByRole('button',{name:'Send message',exact:true}).click();
  await page.waitForFunction(()=>!!(window as any).releaseDelivery);await page.getByRole('button',{name:'Direct messages',exact:true}).click();await page.locator('.dm-section .dm-link').filter({hasText:'Guest'}).click();await page.getByRole('textbox',{name:'Message Guest',exact:true}).fill('New room draft');
  await page.evaluate(()=>(window as any).releaseDelivery());await expect(panel(page)).toContainText('No pending messages');await expect(page.getByRole('textbox',{name:'Message Guest',exact:true})).toHaveValue('New room draft');
});
test('replacing an account closes the old outbox edit confirmation and hides retired owner data',async({page})=>{
  await fixture(page);await page.evaluate(async()=>{await (window as any).enqueueOutbox({id:'confirmation',kind:'scheduled',roomId:'!source:local',body:'Private scheduled original',due:Date.now()+3600000});});
  await expect(panel(page)).toContainText('Private scheduled original');await panel(page).getByRole('button',{name:'Edit',exact:true}).click();await expect(page.getByRole('dialog',{name:'Edit pending item'})).toBeVisible();
  await page.evaluate(()=>(window as any).replaceAccount());await expect(page.getByRole('dialog',{name:'Edit pending item'})).toHaveCount(0);await expect(panel(page)).not.toContainText('Private scheduled original');
  await page.evaluate(async()=>{await (window as any).reopenOutbox();});await expect(panel(page)).toContainText('Private scheduled original');await expect(page.getByRole('dialog',{name:'Edit pending item'})).toHaveCount(0);
});
test('schedule confirmation is tied to the originating composer and consumes its exact draft',async({page})=>{
  await fixture(page);await composer(page).getByRole('textbox').fill('Schedule from Source');await composer(page).getByRole('button',{name:'Schedule this message',exact:true}).click();
  await page.getByRole('dialog',{name:'Schedule message',exact:true}).getByRole('button',{name:'Schedule',exact:true}).click();
  await expect(composer(page).getByRole('textbox')).toHaveValue('');await expect(panel(page)).toContainText('Schedule from Source');
  await expect(page.getByRole('dialog',{name:'Schedule message',exact:true})).toHaveCount(0);
});
