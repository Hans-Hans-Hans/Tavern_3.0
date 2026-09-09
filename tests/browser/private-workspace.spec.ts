import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const names = [...readFileSync('lib/matrix.ts','utf8').matchAll(/export (?:async )?function (\w+)/g)].map(match=>match[1]);

async function fixture(page: Page, query='', hash='') {
  await page.route(url=>url.pathname==='/lib/matrix.ts',route=>route.fulfill({contentType:'text/javascript',body:names.map(name=>'export const '+name+'=(...args)=>window.matrixBoundary('+JSON.stringify(name)+',args);').join('\n')}));
  await page.route('**/config.json',route=>route.fulfill({json:{homeserverUrl:'http://127.0.0.1:5173',serverRolePolicy:true,callsEnabled:false}}));
  await page.route(url=>url.pathname==='/app/media-viewer.tsx',route=>route.fulfill({contentType:'text/javascript',body:"import React from '/node_modules/.vite/deps/react.js';export const MediaViewer=({items,onClose})=>React.createElement('div',{role:'dialog','aria-label':'Attachment gallery'},items.map(item=>React.createElement('p',{key:item.id},item.name)),React.createElement('button',{onClick:onClose},'Close gallery'));"}));
  await page.route('**/private-workspace-test*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/private-workspace.tsx")).mountFixture();</script></body></html>'}));
  await page.goto('/private-workspace-test?'+query+hash);
  await page.waitForFunction(()=>!!(window as any).ready);
  await expect(page.locator('.profile-button')).toContainText('Owner');
}
const panel=(page:Page)=>page.getByRole('complementary',{name:'Private discussion',exact:true});

test('channel launcher opens private Sheet with real composer and a gallery scoped to the private message',async({page})=>{
  await fixture(page);
  await page.getByRole('button',{name:'Channel details',exact:true}).click();
  await page.getByText('Private discussions (1)',{exact:true}).click();
  await page.getByRole('button',{name:'Private One',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await panel(page).getByRole('textbox',{name:'Message Private One',exact:true}).fill('Encrypted through the existing composer');
  await panel(page).getByRole('button',{name:'Send message',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).calls.filter((call:any)=>call[0]==='send').length)).toBe(1);
  const sent=await page.evaluate(()=>(window as any).calls.find((call:any)=>call[0]==='send')[1]);
  expect(sent.conversation).toBe('!private:local');expect(sent.parent).toBeUndefined();expect(sent.serverId).toBe('!server:local');
  await expect(panel(page).getByRole('button',{name:'Reply in thread'})).toHaveCount(0);
  await panel(page).getByRole('button',{name:/secret\.txt/}).click();
  const gallery=page.getByRole('dialog',{name:'Attachment gallery'});
  await expect(gallery).toContainText('secret.txt');await expect(gallery).not.toContainText('public.txt');
});

test('private invitation links open their acceptance panel and source navigation closes the private Sheet',async({page})=>{
  await fixture(page,'invited','#room=%21private%3Alocal');
  await expect(panel(page).getByRole('button',{name:'Accept private discussion'})).toBeVisible();
  await expect(page.locator('.channel-sidebar .channel-link').filter({hasText:'Private One'})).toHaveCount(0);
  await panel(page).getByRole('button',{name:'Accept private discussion'}).click();
  await expect(panel(page).getByRole('textbox',{name:'Message Private One'})).toBeEnabled();
  await panel(page).getByRole('button',{name:'View source conversation'}).click();
  await expect(panel(page)).toHaveCount(0);await expect(page.getByRole('heading',{name:'Source',exact:true,level:1})).toBeVisible();
});

test('delayed public message navigation cannot reopen a public Sheet over a private link target',async({page})=>{
  await fixture(page);
  await page.evaluate(()=>{const w=window as any;w.deferResolve=true;location.hash='room=%21source%3Alocal&event=%24source';});
  await page.waitForFunction(()=>typeof(window as any).resolveDelayed==='function');
  await page.evaluate(()=>{(window as any).deferResolve=false;location.hash='room=%21private%3Alocal&event=%24older';});
  await expect(panel(page).getByText('Older private target',{exact:true})).toBeVisible();
  await page.evaluate(()=>(window as any).resolveDelayed());
  await expect(page.getByRole('dialog')).toHaveCount(1);await expect(page.getByRole('heading',{name:'Private discussion',exact:true})).toBeVisible();
});

test('new discussions wait for sync and remain discoverable after source departure',async({page})=>{
  await fixture(page);
  await page.locator('[id="message-$source"]').hover();
  await page.getByRole('button',{name:'Reply in thread',exact:true}).click();
  await page.getByText('Private discussions (1)',{exact:true}).click();
  await page.getByRole('button',{name:'Create private discussion',exact:true}).click();
  await page.getByRole('textbox',{name:'Discussion title',exact:true}).fill('New Private');
  await page.getByRole('button',{name:'Create encrypted discussion',exact:true}).click();
  await expect(panel(page).getByRole('status')).toHaveText('Waiting for the new discussion to sync…');
  const created=await page.evaluate(()=>(window as any).calls.find((call:any)=>call[0]==='createRoom')[1]);
  expect(created.creation_content['io.tavern.private_thread'].source_event_id).toBe('$source');
  await page.evaluate(()=>(window as any).syncCreated());
  await expect(panel(page).getByRole('textbox',{name:'Message New Private',exact:true})).toBeEnabled();
  await panel(page).getByRole('button',{name:'Close private discussion'}).click();
  await page.evaluate(()=>{const w=window as any;w.source.updateMyMembership('leave');w.source.currentState.getStateEvents('m.room.member','@owner:local').getContent().membership='leave';w.notify();});
  await page.getByRole('button',{name:'Private discussions',exact:true}).click();
  await page.getByRole('button',{name:'New Private Joined · Encrypted',exact:true}).click();
  await expect(panel(page).getByRole('textbox',{name:'Message New Private',exact:true})).toBeDisabled();
  await panel(page).getByText('Discussion settings and 2 members',{exact:true}).click();
  await expect(panel(page).getByRole('button',{name:'Leave private discussion'})).toBeEnabled();
});

test('saved private messages open the private panel and failed link lookups are not repeated on sync',async({page})=>{
  await fixture(page);
  await page.getByRole('button',{name:'Saved for later',exact:true}).click();
  await page.getByRole('button',{name:'#Private One',exact:true}).click();
  await expect(panel(page).getByText('Private message',{exact:true})).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.evaluate(()=>{location.hash='room=%21private%3Alocal&event=%24missing';});
  await expect(panel(page).getByRole('alert')).toContainText('linked private message is unavailable');
  const reads=await page.evaluate(()=>(window as any).resolved.length);
  await page.evaluate(()=>{(window as any).notify();(window as any).notify();});
  await expect(panel(page).getByText('Private message',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).resolved.length)).toBe(reads);
});

test('closed optional panels load on demand and a slow import preserves the conversation draft',async({page})=>{
  let requests=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route(url=>url.pathname==='/app/message-search.tsx',async route=>{requests++;await gate;await route.continue();});
  await fixture(page);
  expect(requests).toBe(0);
  const composer=page.getByRole('textbox',{name:'Message Source',exact:true});
  await composer.fill('Keep this unsent draft');
  await page.getByRole('button',{name:'Search conversations',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Loading message search'})).toBeVisible();
  expect(requests).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(composer).toHaveValue('Keep this unsent draft');
  const response=page.waitForResponse(url=>new URL(url.url()).pathname==='/app/message-search.tsx');
  release();await response;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Search conversations',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Search messages',exact:true})).toBeVisible();
  expect(requests).toBe(1);
  await page.keyboard.press('Escape');
  await expect(composer).toHaveValue('Keep this unsent draft');
});

for(const target of ['source','server'])test('a linked '+target+' invitation closes when sync confirms it already joined',async({page})=>{
  await fixture(page,target+'-invited','#room='+encodeURIComponent('!'+target+':local'));
  await expect(page.getByRole('dialog').getByRole('button',{name:'Join',exact:true})).toBeVisible();
  await page.evaluate(target=>(window as any).client.joinRoom('!'+target+':local'),target);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Tavern home',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Message Source',exact:true})).toBeEnabled();
});
