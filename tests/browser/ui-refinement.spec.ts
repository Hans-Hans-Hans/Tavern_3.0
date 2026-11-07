import { test, expect } from '@playwright/test';
import { workspaceFixture } from './support/workspace-fixture';
import { mkdirSync, readFileSync } from 'node:fs';
const packageInfo = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('startup opens a real server without a synthetic Tavern or All channels destination',async({page})=>{
  await workspaceFixture(page,true,'?management=1');
  await expect(page.locator('.workspace-select strong')).toHaveText('Games server');
  await expect(page.locator('.workspace-rail').getByRole('button',{name:'All channels',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Games server',exact:true})).toHaveAttribute('aria-current','page');
  await page.locator('.workspace-select').click();
  await expect(page.getByRole('menuitem',{name:'All channels',exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{const f=(window as any).dmFixture;f.add('!standalone:local',{name:'Standalone room',membership:'join',direct:false});f.emit();});
  await page.getByRole('button',{name:'Tavern home',exact:true}).click();
  await page.getByRole('region',{name:'Other conversations'}).getByRole('button',{name:'Standalone room',exact:true}).click();
  await expect(page.locator('.channel-heading')).toContainText('Standalone room');
  await expect(page.locator('.channel-navigation').getByRole('button',{name:'Lobby',exact:true})).toHaveCount(0);
});

test('workspace refinement screenshots', async ({ page }) => {
  test.setTimeout(120000);
  mkdirSync('work/ui-refinement', { recursive: true });
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({ width: 1440, height: 1000 });
  await workspaceFixture(page, true, '?management=1');
  await page.getByRole('button', { name: 'Games server', exact: true }).click();
  await page.getByRole('button', { name: 'Lobby', exact: true }).click();
  await expect(page.locator('.channel-heading')).toContainText('Lobby');
  const phase = process.env.TAVERN_CAPTURE_BEFORE ? 'before' : 'after';
  for (const width of [375, 430, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    if (!process.env.TAVERN_CAPTURE_BEFORE) {
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('textbox', { name: 'Message Lobby', exact: true })).toBeVisible();
    }
    await page.screenshot({ path: `work/ui-refinement/${phase}-${width}.png`, fullPage: true });
  }
  if (!process.env.TAVERN_CAPTURE_BEFORE) {
    await page.setViewportSize({ width:1440, height:1000 });
    await page.evaluate(async () => { const path='/lib/appearance.ts'; const appearance=await import(/* @vite-ignore */ path); await appearance.saveAppearance({theme:'dark'}); });
    await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
    await page.screenshot({ path:'work/ui-refinement/after-dark-1440.png',fullPage:true });
  }
});

test('information defaults closed, persists through account sync and uses a dismissible tablet drawer', async ({ page }) => {
  await page.setViewportSize({width:1440,height:1000});
  await workspaceFixture(page,true,'?management=1');
  await expect(page.locator('.channel-overview')).toHaveCount(0);
  await page.getByRole('button',{name:'Show channel information',exact:true}).click();
  await expect(page.getByRole('complementary',{name:'Channel information'})).toBeVisible();
  await page.evaluate(()=> (window as any).dmFixture.emit());
  await expect(page.getByRole('button',{name:'Hide channel information',exact:true})).toHaveAttribute('aria-expanded','true');
  expect(await page.evaluate(()=>(window as any).dmFixture.client.getAccountData('io.tavern.appearance').getContent().memberList)).toBe(true);
  await page.setViewportSize({width:768,height:1000});
  await expect(page.getByRole('dialog',{name:'Channel information',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog',{name:'Channel information',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Show channel information',exact:true})).toBeFocused();
  expect(await page.evaluate(()=>(window as any).dmFixture.client.getAccountData('io.tavern.appearance').getContent().memberList)).toBe(false);
});

test('an existing explicit information-panel preference is honored',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  await page.addInitScript(()=>{(window as any).initialAppearance={memberList:true};});
  await workspaceFixture(page,true,'?management=1');
  await expect(page.getByRole('complementary',{name:'Channel information'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Hide channel information',exact:true})).toHaveAttribute('aria-expanded','true');
});

test('profile menu separates personal settings from server controls and hides unauthorized administration', async ({page})=>{
  await workspaceFixture(page,true,'?management=1');
  await expect(page.locator('.connection .version')).toHaveText('v'+packageInfo.version);
  await page.getByRole('button',{name:'Games server',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Channels',exact:true})).toHaveCount(1);
  await expect(page.getByText('Categories',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Uncategorized',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Your profile',exact:true}).click();
  await expect(page.getByRole('menuitem',{name:'Personal settings',exact:true})).toBeVisible();
  await expect(page.getByRole('menuitem',{name:'Administration',exact:true})).toHaveCount(0);
  await page.getByRole('menuitem',{name:'Personal settings',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Make Tavern yours'})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Your profile',exact:true}).click();
  await page.getByRole('menuitem',{name:'About Tavern',exact:true}).click();
  await expect(page.locator('.about-tavern h2')).toContainText(packageInfo.version);
  await expect(page.locator('.about-tavern time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Channel actions',exact:true}).click();
  await expect(page.getByRole('menuitem',{name:'Create channel',exact:true})).toBeVisible();
  await expect(page.getByRole('menuitem',{name:'Create category',exact:true})).toBeVisible();
});

test('security reads SDK room state and device verification independently',async({page})=>{
  await workspaceFixture(page,true,'?management=1');
  await page.getByRole('button',{name:/^Room security:/}).click();
  await expect(page.getByText('This room has Matrix end-to-end encryption enabled.',{exact:true})).toBeVisible();
  await expect(page.getByText('Encryption is not available on this device',{exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{
    const w=window as any;w.deviceVerified=false;
    const crypto={getDeviceVerificationStatus:async()=>({isVerified:()=>w.deviceVerified})};
    w.dmFixture.client.getCrypto=()=>crypto;w.dmFixture.emit();
  });
  await expect(page.getByRole('button',{name:'Room security: Encrypted · check device',exact:true})).toBeVisible();
  await page.evaluate(()=>{(window as any).deviceVerified=true;(window as any).dmFixture.emit();});
  await expect(page.getByRole('button',{name:'Room security: Encrypted',exact:true})).toBeVisible();
  await page.evaluate(()=>{
    const f=(window as any).dmFixture;
    f.add('!plain:local',{plain:true,name:'Plain room',membership:'join',direct:false});f.emit();
  });
  await page.getByRole('button',{name:'Tavern home',exact:true}).click();
  await page.getByRole('region',{name:'Other conversations'}).getByRole('button',{name:'Plain room',exact:true}).click();
  await expect(page.getByRole('button',{name:'Room security: Not encrypted',exact:true})).toBeVisible();
});

test('composer grows with wrapped drafts, caps long text, and respects IME and Enter shortcuts',async({page})=>{
  await workspaceFixture(page,true,'?management=1');
  const input=page.getByRole('textbox',{name:'Message Lobby',exact:true});
  await expect(input).toBeVisible();
  const compact=await input.evaluate(el=>el.getBoundingClientRect().height);
  expect(compact).toBeLessThan(60);
  await input.fill(Array.from({length:20},(_,i)=>'Line '+i).join('\n'));
  await expect.poll(()=>input.evaluate(el=>el.clientHeight)).toBeGreaterThan(compact);
  expect(await input.evaluate(el=>el.getBoundingClientRect().height)).toBeLessThanOrEqual(181);
  expect(await input.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
  await input.fill('Draft stays here');
  await page.getByRole('button',{name:'Games server',exact:true}).click();
  await page.getByRole('button',{name:'Gaming Voice',exact:true}).click();
  await page.getByRole('button',{name:'Lobby',exact:true}).click();
  await expect(input).toHaveValue('Draft stays here');
  await input.dispatchEvent('keydown',{key:'Enter',isComposing:true});
  expect(await page.evaluate(()=>(window as any).workspaceCalls.filter(([action]:string[])=>action==='send').length)).toBe(0);
  await input.press('Shift+Enter');
  expect(await input.inputValue()).toContain('\n');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect(await page.evaluate(()=>(window as any).workspaceCalls.filter(([action]:string[])=>action==='send').length)).toBe(1);
  await page.evaluate(()=>{const f=(window as any).dmFixture;f.accountData('io.tavern.text_media',{enterToSend:false});f.emit();});
  await input.fill('Use the configured shortcut'); await input.press('Enter');
  expect(await page.evaluate(()=>(window as any).workspaceCalls.filter(([action]:string[])=>action==='send').length)).toBe(1);
  await input.press('Control+Enter'); await expect(input).toHaveValue('');
  expect(await page.evaluate(()=>(window as any).workspaceCalls.filter(([action]:string[])=>action==='send').length)).toBe(2);
});

test('short timelines sit at the bottom and appended messages do not move a reader away from older messages',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  await workspaceFixture(page,true,'?management=1');
  await page.evaluate(()=>{
    const w=window as any;w.makeTestMessage=(n:number)=>({id:'$ui-'+n,body:'Message '+n,author_id:'@alice:local',author_name:'Alice',conversation_id:'!lobby:local',conversation_name:'Lobby',created_at:1700000000000+n*1000,edited_at:null,parent_id:null,pinned:0,saved:0,replies:0,reactions:[],attachments:[]});
    w.workspaceTestMessages=[w.makeTestMessage(1),w.makeTestMessage(2)];w.dmFixture.emit();
  });
  await expect(page.getByText('Message 2',{exact:true})).toBeVisible();
  const scroller=page.locator('.message-scroll');
  await expect.poll(()=>page.getByText('Message 2',{exact:true}).evaluate(el=>el.getBoundingClientRect().bottom)).toBeGreaterThan(700);
  await page.screenshot({path:'work/ui-refinement/after-short-history-1440.png',fullPage:true});
  await page.evaluate(()=>{const w=window as any;w.workspaceTestMessages=Array.from({length:100},(_,i)=>w.makeTestMessage(i+1));w.dmFixture.emit();});
  await expect(page.getByText('Message 100',{exact:true})).toBeVisible();
  await scroller.evaluate(el=>{el.scrollTop=0;});
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page.getByText('Message 1',{exact:true})).toBeVisible();
  const top=await scroller.evaluate(el=>el.scrollTop);
  await page.evaluate(()=>{const w=window as any;w.workspaceTestMessages.push(w.makeTestMessage(101));w.dmFixture.emit();});
  await expect(page.getByRole('button',{name:'New messages · Jump to latest',exact:true})).toBeVisible();
  expect(Math.abs(await scroller.evaluate(el=>el.scrollTop)-top)).toBeLessThan(3);
  await page.getByRole('button',{name:'New messages · Jump to latest',exact:true}).click();
  await expect(page.getByText('Message 101',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'New messages · Jump to latest',exact:true})).toHaveCount(0);
});
