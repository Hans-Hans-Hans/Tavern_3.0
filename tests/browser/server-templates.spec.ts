import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Use the actual shared editor; isolate crop and upload to control their timing.
const communitySource = readFileSync(new URL('../../app/community-settings.tsx', import.meta.url), 'utf8');
const imageEditor = ts.transpileModule(`import React from '/node_modules/.vite/deps/react.js';
const {useEffect,useState}=React;
export const CommunityImage=()=>null;
const cropProfileImage=async()=>{if(window.delayCrop)await new Promise(resolve=>window.resolveCrop=resolve);return new Blob(['image'],{type:'image/png'});};
const uploadProfileImage=async()=>{window.imageUploads=(window.imageUploads||0)+1;return 'mxc://test/uploaded-icon';};
${communitySource.slice(communitySource.indexOf('export function ImageEditor('), communitySource.indexOf('export function ProfileSettings('))}
`, { fileName: 'editor-fixture.tsx', compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;

async function fixture(page: Page, options: { policy?: boolean; partial?: boolean; unknown?: boolean; delayed?: boolean; artwork?: boolean } = {}) {
  let editorModule = imageEditor;
  if (options.artwork) {
    const compiled = await (await page.request.get('/app/server-dialog.tsx')).text();
    const reactUrl = compiled.match(/from ["']([^"']+\/react\.js[^"']*)["']/)?.[1];
    if (!reactUrl) throw new Error('The fixture could not resolve the app React runtime.');
    editorModule = imageEditor.replace('/node_modules/.vite/deps/react.js', reactUrl);
  }
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const getMatrixClient=()=>window.fixtureClient;export const matrixApi=async(action,payload)=>{window.serverCreates++;window.serverPayload=payload;if(window.delayCreate)await new Promise(resolve=>window.resolveCreate=resolve);if(window.unknownCreate)throw new Error('Connection interrupted.');return {id:'!server:test'}};` }));
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const accountArtworkOwner=()=>window.fixtureOwner;` }));
  await page.route(url => url.pathname === '/lib/instance.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const readInstanceConfig=async()=>({serverRolePolicy:window.policyEnabled});` }));
  await page.route(url => url.pathname === '/app/community-settings.tsx', route => route.fulfill({ contentType: 'text/javascript', body: options.artwork ? editorModule : `export const ImageEditor=()=>null;export const CommunityImage=()=>null;` }));
  await page.route(url => url.pathname === '/lib/channel-policy.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const channelKinds={text:'Text',voice:'Voice',video:'Video',forum:'Forum',announcement:'Announcement',rules:'Rules',media:'Media','read-only':'Read only'};` }));
  await page.route(url => url.pathname === '/lib/channel-creation.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const channelTemplates=Object.fromEntries(['text','voice','video','forum','announcement','rules','media','read-only'].map(kind=>[kind,{icon:'#',guidance:'Channel guidance.'}]));export const createTypedChannel=async draft=>{window.channelCreates.push(draft);return {roomId:'!'+draft.name+':test',name:draft.name,linked:true,categoryApplied:true,invited:[],pendingMembers:[],errors:window.partial&&draft.name==='hangout'?['Link update needs retry.']:[]}};export const finishChannelCreation=async result=>{window.finished.push(result.roomId);return {...result,errors:[]}};` }));
  await page.route('**/server-template-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>window.fixtureClient={};window.fixtureOwner={};window.serverCreates=0;window.channelCreates=[];window.finished=[];window.completed=[];window.policyEnabled=${options.policy !== false};window.partial=${!!options.partial};window.unknownCreate=${!!options.unknown};window.delayCreate=${!!options.delayed};</script><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;await import('/tests/browser/fixtures/server-templates.tsx');</script></body></html>` }));
  await page.goto('/server-template-test');
}
async function start(page: Page, template = 'Friends') {
  await page.getByLabel('Name', { exact: true }).fill('Friends space');
  await page.getByRole('radio', { name: new RegExp('^' + template) }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeFocused();
}

test('editable layout previews category placement and retries only remaining setup', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page, { partial: true }); await start(page);
  await page.getByRole('checkbox', { name: /photos/ }).uncheck();
  await page.getByLabel('Category 1', { exact: true }).fill('Our conversations');
  await page.getByText('Edit channel 1', { exact: true }).click();
  await page.getByLabel('Channel 1 name', { exact: true }).fill('welcome');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Server preview' });
  await expect(preview).toContainText('Our conversations'); await expect(preview).toContainText('welcome'); await expect(preview).not.toContainText('photos');
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Link update needs retry');
  await page.getByRole('button', { name: 'Finish remaining setup' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).completed.length)).toBe(1);
  const result = await page.evaluate(() => ({ creates: (window as any).serverCreates, payload: (window as any).serverPayload, channels: (window as any).channelCreates, finished: (window as any).finished, completed: (window as any).completed }));
  expect(result.creates).toBe(1); expect(result.payload.categories[0].name).toBe('Our conversations');
  expect(result.channels.map((item: any) => [item.name, item.categoryId])).toEqual([['welcome', 'together'], ['hangout', 'hangouts']]);
  expect(result.finished).toEqual(['!hangout:test']); expect(result.completed[0]).toEqual(['!server:test', '!welcome:test']);
});

test('custom channels validate before any writes and category removal preserves channels', async ({ page }) => {
  await fixture(page); await start(page, 'Custom');
  await page.getByRole('button', { name: 'Add channel', exact: true }).click();
  await page.getByText('Edit channel 2', { exact: true }).click();
  await page.getByLabel('Channel 2 name', { exact: true }).fill('GENERAL');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('unique name');
  expect(await page.evaluate(() => (window as any).serverCreates)).toBe(0);
  await page.getByLabel('Channel 2 name', { exact: true }).fill('plans');
  await page.getByRole('button', { name: 'Remove category 1', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Channel 2 category', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Server preview' })).toContainText('Ungrouped');
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).completed.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).channelCreates.map((item: any) => item.name))).toEqual(['general', 'plans']);
});

test('switching templates preserves edits and category order while the dialog is open', async ({ page }) => {
  await fixture(page); await start(page);
  await page.getByLabel('Category 1', { exact: true }).fill('Our place');
  await page.getByRole('button', { name: 'Move category 1 down', exact: true }).click();
  await page.getByRole('checkbox', { name: /photos/ }).uncheck();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('radio', { name: /^Gaming/ }).check();
  await page.getByRole('radio', { name: /^Friends/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Category 2', { exact: true })).toHaveValue('Our place');
  await expect(page.getByRole('checkbox', { name: /photos/ })).not.toBeChecked();
});

test('uploaded icon is included in creation and crop work blocks navigation', async ({ page }) => {
  await fixture(page, { artwork: true });
  await page.getByLabel('Name', { exact: true }).fill('With artwork');
  await page.getByText('Add a server icon (optional)', { exact: true }).click();
  await page.getByLabel('Choose server icon', { exact: true }).setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: Buffer.from('fixture') });
  await expect(page.getByRole('button', { name: 'Use cropped image', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).delayCrop = true; });
  await page.getByRole('button', { name: 'Use cropped image', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Uploading icon…', exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).resolveCrop(); });
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).serverPayload.icon)).toBe('mxc://test/uploaded-icon');
});

test('account changes during cropping cannot upload an icon under the new account', async ({ page }) => {
  await fixture(page, { artwork: true });
  await page.getByText('Add a server icon (optional)', { exact: true }).click();
  await page.getByLabel('Choose server icon', { exact: true }).setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: Buffer.from('fixture') });
  await expect(page.getByRole('button', { name: 'Use cropped image', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).delayCrop = true; });
  await page.getByRole('button', { name: 'Use cropped image', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).resolveCrop)).toBe('function');
  await page.evaluate(() => { const w = window as any; w.fixtureOwner = {}; w.resolveCrop(); });
  await expect(page.getByRole('alert')).toContainText('account changed');
  expect(await page.evaluate(() => (window as any).imageUploads || 0)).toBe(0);
});

test('unsupported channel types are unavailable and never created', async ({ page }) => {
  await fixture(page, { policy: false }); await start(page);
  await expect(page.getByRole('checkbox', { name: /hangout/ })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /photos/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).completed.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).channelCreates.map((item: any) => item.kind))).toEqual(['text']);
});

test('unknown creation acknowledgement prevents duplicates', async ({ page }) => {
  await fixture(page, { unknown: true }); await start(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Automatic creation retries are paused');
  await expect(page.getByRole('button', { name: 'Create server', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => [(window as any).serverCreates, (window as any).channelCreates.length])).toEqual([1, 0]);
});

test('account switch during creation stops channel writes and navigation', async ({ page }) => {
  await fixture(page, { delayed: true }); await start(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).resolveCreate)).toBe('function');
  await page.evaluate(async () => { const w = window as any; w.fixtureOwner = {}; w.resolveCreate(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(await page.evaluate(() => [(window as any).channelCreates.length, (window as any).completed.length])).toEqual([0, 0]);
});

test('opening continuation is cancelled if the account changes during workspace refresh', async ({ page }) => {
  await fixture(page); await start(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.evaluate(() => { (window as any).delayOpen = true; });
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).resolveOpen)).toBe('function');
  await page.evaluate(async () => { const w = window as any; w.fixtureOwner = {}; w.resolveOpen(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(await page.evaluate(() => (window as any).completed)).toEqual([]);
});

for (const width of [320, 375, 430, 768, 1280]) test(`wizard fits ${width}px with usable controls and keyboard navigation`, async ({ page }) => {
  await page.setViewportSize({ width, height: 850 }); await fixture(page);
  await page.getByLabel('Name', { exact: true }).fill('A welcoming community with a long name');
  await expect.poll(async () => { const close = await page.getByRole('button', { name: 'Close', exact: true }).boundingBox(); return close ? Math.round(Math.min(close.height, close.width) * 100) / 100 : 0; }).toBeGreaterThanOrEqual(44);
  if (width === 1280) await page.screenshot({ path: 'work/server-wizard-desktop.png' });
  await page.getByRole('radio', { name: /^Friends/ }).focus(); await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeFocused();
  for (const step of [1, 2]) {
    const dialog = page.getByRole('dialog');
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.locator('.server-creation-form').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const primary = page.getByRole('button', { name: step === 1 ? 'Continue' : 'Create server', exact: true });
    expect((await primary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const footer = (await page.locator('.server-creation-footer').boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(footer.y).toBeGreaterThanOrEqual(0);
    expect(footer.y + footer.height).toBeLessThanOrEqual(viewport.height);
    if (step === 1) await primary.click();
  }
  await expect(page.getByRole('region', { name: 'Server preview' })).toContainText('hangout');
  if (width === 320) await page.screenshot({ path: 'work/server-wizard-mobile.png' });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /hangout/ })).toBeChecked();
});
