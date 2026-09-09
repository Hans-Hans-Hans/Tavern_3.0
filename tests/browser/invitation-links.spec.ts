import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, mode = 'manager') {
  await page.addInitScript(mode => {
    const target = window as any;
    Object.assign(target, { inviteMode: mode, inviteOwner: {}, inviteActor: '@owner:test', inviteAllowed: true, inviteCanManage: true, inviteResponses: 0, joinedInvites: [], copiedInvites: [], inviteListeners: new Set() });
    target.changeInviteAccount = () => { target.inviteOwner = {}; for (const listener of target.inviteListeners) listener(); };
    target.publishInviteState = () => { for (const listener of target.inviteListeners) listener(); };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { target.copiedInvites.push(text); } } });
  }, mode);
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    const event=(content,sender='@owner:test')=>({getContent:()=>content,getSender:()=>sender});
    const rooms=new Map();
    const room=id=>{if(!rooms.has(id))rooms.set(id,{roomId:id,isSpaceRoom:()=>true,getMyMembership:()=>window.inviteAllowed?'join':'leave',currentState:{maySendStateEvent:()=>true,getStateEvents:(kind,key)=>{
      if(kind==='m.room.create')return event({type:'m.space','m.federate':false});
      if(kind==='m.room.power_levels')return event({users:{'@owner:test':100},state_default:50,invite:0});
      if(kind==='io.tavern.roles')return event({version:1,owner:window.inviteCanManage?'@owner:test':'@other:test',roles:[{id:'everyone',name:'Member',position:0,permissions:['invite']}],members:{}});
      return key===undefined?[]:null;
    }}});return rooms.get(id);};
    const client={getUserId:()=>window.inviteActor,getRoom:room};export const getMatrixClient=()=>client;
    export const onMatrixUpdate=listener=>{window.inviteListeners.add(listener);return()=>window.inviteListeners.delete(listener);};` }));
  await page.route(url => url.pathname === '/lib/interactions.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const canInviteToRoom=()=>window.inviteAllowed;' }));
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    export const accountArtworkOwner=()=>window.inviteOwner;
    export const requestApi=async(path,body,method=body===undefined?'GET':'POST')=>{const response=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();window.inviteResponses++;if(!response.ok)throw new Error(value.error||'Failed');return value;};` }));
  await page.route(url => url.pathname === '/app/auth-gateway.tsx', route => route.fulfill({ contentType: 'application/javascript', body: 'import React from "/node_modules/.vite/deps/react.js";export const Field=({label,children})=>React.createElement("label",null,label,children);' }));
  await page.route(url => url.pathname === '/app/invitation-splash.tsx', route => route.fulfill({ contentType: 'application/javascript', body: 'export const InvitationSplash=()=>null;' }));
  await page.route('**/api/auth/config', route => route.fulfill({ json: { smtpConfigured: true } }));
  const path = mode === 'redeem' ? '/invite/guild-night?recovery=kept#room=preserved' : '/invitation-test';
  await page.route(url => url.pathname === '/invitation-test' || url.pathname.startsWith('/invite/'), route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/invitation-links.tsx")).mountFixture();</script></body></html>' }));
  await page.goto(path);
}

test('manager creates and recopies a custom link with existing restrictions', async ({ page }) => {
  let invitation: any, submitted: any;
  await page.route('**/api/invitations*', route => {
    if (route.request().method() === 'POST') {
      submitted = route.request().postDataJSON();
      invitation = { id: 'invite-one', customSlug: submitted.customSlug, url: 'https://tavern.test/invite/' + submitted.customSlug, creator: '@owner:test', createdAt: Date.now(), expiresAt: Date.now() + 3600000, uses: 0, maxUses: submitted.maxUses, email: submitted.email, defaultRoleIds: [] };
      return route.fulfill({ status: 201, json: invitation });
    }
    return route.fulfill({ json: { invitations: invitation ? [invitation] : [] } });
  });
  await fixture(page);
  await page.getByLabel('Custom invitation name (optional)').fill('guild-night');
  await expect(page.getByText(/Custom links are public and guessable/)).toBeVisible();
  await page.getByLabel('Maximum uses').fill('3');
  await page.getByLabel('Restrict to verified email (optional)').fill('friend@example.test');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy custom link guild-night' })).toBeVisible();
  expect(submitted).toMatchObject({ roomId: '!guild:test', customSlug: 'guild-night', maxUses: 3, email: 'friend@example.test', defaultRoleIds: [] });
  await page.getByRole('button', { name: 'Copy custom link guild-night' }).click();
  expect(await page.evaluate(() => (window as any).copiedInvites)).toEqual(['http://127.0.0.1:5173/invite/guild-night']);
});

test('late create results cannot cross an account generation and room changes clear the draft', async ({ page }) => {
  let releaseCreate!: () => void;
  await page.route('**/api/invitations*', async route => {
    if (route.request().method() === 'POST') {
      await new Promise<void>(resolve => { releaseCreate = resolve; });
      return route.fulfill({ status: 201, json: { customSlug: 'stale-name', url: 'https://tavern.test/invite/stale-name' } });
    }
    return route.fulfill({ json: { invitations: [] } });
  });
  await fixture(page);
  await page.getByLabel('Custom invitation name (optional)').fill('stale-name');
  const requested = page.waitForRequest(request => request.url().includes('/api/invitations') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click(); await requested;
  await page.evaluate(() => { (window as any).changeInviteAccount(); (window as any).changeInviteAccount(); });
  await expect(page.getByLabel('Custom invitation name (optional)')).toHaveValue('');
  const response = page.waitForResponse(request => request.url().includes('/api/invitations') && request.request().method() === 'POST');
  releaseCreate(); await response;
  await expect(page.getByText('https://tavern.test/invite/stale-name', { exact: true })).toHaveCount(0);
  await page.getByLabel('Custom invitation name (optional)').fill('fresh-name');
  await page.evaluate(() => (window as any).switchInviteRoom('!other:test'));
  await expect(page.getByLabel('Custom invitation name (optional)')).toHaveValue('');
});

test('a delayed invitation list cannot populate a different server', async ({ page }) => {
  let release!: () => void;
  await page.route('**/api/invitations*', async route => {
    const first = new URL(route.request().url()).searchParams.get('roomId') === '!guild:test';
    if (first) await new Promise<void>(resolve => { release = resolve; });
    return route.fulfill({ json: { invitations: first ? [{ id: 'old', customSlug: 'old-server', createdAt: 1, expiresAt: Date.now() + 10000, maxUses: 1, uses: 0 }] : [] } });
  });
  await fixture(page);
  await page.getByLabel('Custom invitation name (optional)').fill('draft');
  await page.evaluate(() => (window as any).switchInviteRoom('!other:test'));
  await expect(page.getByLabel('Custom invitation name (optional)')).toHaveValue('');
  const response = page.waitForResponse(request => new URL(request.url()).searchParams.get('roomId') === '!guild:test');
  release(); await response;
  await expect(page.getByRole('button', { name: 'Copy custom link old-server' })).toHaveCount(0);
});

test('losing management authority preserves the draft and prevents a custom create', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/invitations*', route => { if (route.request().method() === 'POST') posts++; return route.fulfill({ json: { invitations: [] } }); });
  await fixture(page);
  await page.getByLabel('Custom invitation name (optional)').fill('retained-name');
  await page.evaluate(() => { (window as any).inviteCanManage = false; (window as any).publishInviteState(); });
  await expect(page.getByLabel('Custom invitation name (optional)')).toHaveValue('retained-name');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('permission to manage');
  expect(posts).toBe(0);
});

test('custom invitation acceptance uses the existing endpoint and preserves unrelated URL state', async ({ page }) => {
  let token: any;
  await page.route('**/api/invitations/preview/*', route => route.fulfill({ json: { roomName: 'Guild', requiresEmail: true } }));
  await page.route('**/api/invitations/redeem', route => { token = route.request().postDataJSON(); return route.fulfill({ json: { roomId: '!guild:test' } }); });
  await fixture(page, 'redeem');
  await expect(page.getByRole('heading', { name: 'Join Guild' })).toBeVisible();
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(token).toEqual({ token: 'v:guild-night' });
  expect(page.url()).toContain('/?recovery=kept#room=preserved');
  expect(await page.evaluate(() => (window as any).joinedInvites)).toEqual(['!guild:test']);
});

test('late acceptance cannot navigate or close a newly opened invitation', async ({ page }) => {
  let release!: () => void;
  await page.route('**/api/invitations/preview/*', route => route.fulfill({ json: { roomName: route.request().url().includes('another-night') ? 'Another guild' : 'Guild' } }));
  await page.route('**/api/invitations/redeem', async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ json: { roomId: '!guild:test' } }); });
  await fixture(page, 'redeem');
  const requested = page.waitForRequest('**/api/invitations/redeem');
  await page.getByRole('button', { name: 'Accept invitation' }).click(); await requested;
  await page.evaluate(() => { history.pushState(null, '', '/invite/another-night?recovery=kept'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('heading', { name: 'Join Another guild' })).toBeVisible();
  const response = page.waitForResponse('**/api/invitations/redeem'); release(); await response;
  await expect(page.getByRole('heading', { name: 'Join Another guild' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).joinedInvites)).toEqual([]);
  expect(page.url()).toContain('/invite/another-night?recovery=kept');
});

test('a delayed preview cannot become actionable after the account generation changes', async ({ page }) => {
  let release!: () => void, calls = 0;
  await page.route('**/api/invitations/preview/*', async route => {
    const first = ++calls === 1;
    if (first) await new Promise<void>(resolve => { release = resolve; });
    return route.fulfill({ json: { roomName: first ? 'Old account preview' : 'Current preview' } });
  });
  await fixture(page, 'redeem');
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeDisabled();
  await page.evaluate(() => { (window as any).inviteOwner = {}; dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('heading', { name: 'Join Current preview' })).toBeVisible();
  const response = page.waitForResponse('**/api/invitations/preview/*'); release(); await response;
  await expect(page.getByRole('heading', { name: 'Join Current preview' })).toBeVisible();
  await expect(page.getByText('Old account preview')).toHaveCount(0);
});

test('actual auth gateway permits eligible custom-link registration without rewriting recovery parameters', async ({ page }) => {
  let submitted: any;
  await page.route('**/api/auth/config', route => route.fulfill({ json: { bootstrapRequired: false, smtpConfigured: true, registrationMode: 'invite', instance: { name: 'Tavern' } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ status: 401, json: { error: 'Sign in' } }));
  await page.route('**/api/auth/register/start', route => { submitted = route.request().postDataJSON(); return route.fulfill({ json: { challengeId: 'challenge' } }); });
  await page.goto('/invite/guild-night?recovery=kept');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Username or email').fill('friend'); await page.getByLabel('Display name', { exact: true }).fill('Friend');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.test');
  await page.getByLabel('New password', { exact: true }).fill('Strong test password!'); await page.getByLabel('Confirm password').fill('Strong test password!');
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await expect(page.getByLabel('Verification code')).toBeVisible();
  expect(submitted.inviteToken).toBe('v:guild-night'); expect(page.url()).toContain('?recovery=kept');
  await page.goto('/invite/admin?recovery=kept');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create an account' })).toHaveCount(0);
});
