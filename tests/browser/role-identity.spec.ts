import { expect, test, type Page } from '@playwright/test';
async function fixture(page: Page) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const getMatrixClient=()=>window.roleIdentityFixture?.client;export const onMatrixUpdate=fn=>{window.roleIdentityFixture.listeners.add(fn);return()=>window.roleIdentityFixture.listeners.delete(fn)};' }));
  await page.route(url => url.pathname === '/lib/community.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const readMemberProfile=(_room,user)=>({name:window.roleIdentityFixture.members.find(m=>m.userId===user)?.name||user,avatar:"",bio:"",status:"",accent:""});export const readMemberProfileContext=()=>({mutualServers:[]});' }));
  await page.route(url => url.pathname === '/app/community-settings.tsx', route => route.fulfill({ contentType: 'text/javascript', body: 'export const CommunityImage=()=>null;' }));
  await page.route('**/role-identity-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/role-identity.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/role-identity-test'); await expect(page.getByRole('region',{name:'Chat name'})).toBeVisible();
}
test('chat and directory share highest color and one icon; profiles retain the complete sorted role list', async ({ page }) => {
  await fixture(page); const chat=page.getByRole('region',{name:'Chat name'});
  await expect(chat.locator('.server-role-name-text')).toHaveCSS('color','rgb(180, 140, 242)'); await expect(chat.getByRole('img',{name:'Gardeners role'})).toHaveCount(1);
  await expect(page.getByRole('region',{name:'Direct-message name'}).locator('.server-role-name-icon')).toHaveCount(0);
  const group=page.getByRole('region',{name:'Gardeners'}); await expect(group).toContainText('Morgan'); await expect(group).not.toContainText('River'); await expect(page.getByRole('region',{name:'Offline'})).toContainText('River');
  await group.getByRole('button',{name:/^Morgan/}).click();
  const profile=page.locator('.quick-profile'); await expect(profile.getByLabel('Server roles')).toContainText('Designers'); await expect(profile.getByLabel('Server roles')).toContainText('Gardeners');
  expect(await profile.locator('.server-role-badge').allTextContents()).toEqual(['Designers','🌱Gardeners']);
  await page.keyboard.press('Escape'); await page.evaluate(()=>{const f=(window as any).roleIdentityFixture;f.policy.roles.find((r:any)=>r.id==='color').icon='⭐';f.policy.roles.find((r:any)=>r.id==='color').color='#6699ff';f.notify();});
  await expect(chat.getByRole('img',{name:'Designers role'})).toHaveCount(1);await expect(chat.locator('.server-role-name-text')).toHaveCSS('color','rgb(102, 153, 255)');
});
test('leaving the server or changing accounts retires role identity without leaking it into direct messages', async ({page})=>{
  await fixture(page);await page.evaluate(()=>{const f=(window as any).roleIdentityFixture;f.membership='leave';f.notify();});
  await expect(page.locator('.server-role-name-icon')).toHaveCount(0);
  await page.evaluate(()=>{const f=(window as any).roleIdentityFixture;f.client=null;f.notify();});
  await expect(page.getByRole('region',{name:'Chat name'})).toContainText('Morgan');await expect(page.locator('.server-role-badges')).toHaveCount(0);
});
test('chat names support profile clicks and role actions through the composed context menu', async ({page})=>{
  await fixture(page);const name=page.getByRole('region',{name:'Chat name'}).getByRole('button');
  await name.click();await expect(page.locator('.quick-profile')).toBeVisible();await page.keyboard.press('Escape');
  await name.click({button:'right'});await page.getByRole('menuitem',{name:'Assign roles',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).roleIdentityFixture.assignmentOpened)).toBe(true);
});
for(const width of [320,375,1280])test('role names and profile badges fit at '+width+'px',async({page})=>{
  await page.setViewportSize({width,height:800});await fixture(page);
  await page.getByRole('region',{name:'Gardeners'}).getByRole('button',{name:/^Morgan/}).click();
  await expect(page.locator('.quick-profile')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.locator('.quick-profile .server-role-name')).toHaveCSS('flex-direction','row');
});
