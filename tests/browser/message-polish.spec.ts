import { test, expect } from '@playwright/test';
test.beforeEach(async({page})=>{
  await page.route(url=>url.pathname==='/lib/matrix.ts',route=>route.fulfill({contentType:'text/javascript',body:`export const getMatrixClient=()=>window.fixtureClient;export const matrixApi=async()=>{window.calls++;return new Promise((resolve,reject)=>{window.failReaction=()=>reject(new Error('Reaction denied by server'));window.finishReaction=resolve;});};`}));
  await page.route(url=>url.pathname==='/app/community-settings.tsx',route=>route.fulfill({contentType:'text/javascript',body:'export const CommunityImage=()=>null;'}));
  await page.route('**/message-polish-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/message-polish.tsx')).mountFixture();</script></body></html>`}));
  await page.goto('/message-polish-test');
});
test('reaction toggles immediately, prevents duplicate submission and rolls back a denial',async({page})=>{
  await page.getByRole('button',{name:'Add 👍 reaction'}).click();
  await expect(page.getByRole('button',{name:'Remove 👍 reaction'})).toBeDisabled();
  await expect(page.getByRole('button',{name:'View 2 people reacting with 👍'})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).calls)).toBe(1);
  await page.evaluate(()=>(window as any).failReaction());
  await expect(page.getByRole('button',{name:'Add 👍 reaction'})).toBeEnabled();
  await expect(page.getByRole('button',{name:'View 1 people reacting with 👍'})).toBeVisible();
  await expect(page.getByText('Reaction denied by server')).toBeVisible();
  await page.getByRole('button',{name:'View 1 people reacting with 👍'}).click();
  await page.getByRole('button',{name:'View Peer profile'}).click();
  expect(await page.evaluate(()=>(window as any).profiles)).toEqual(['@peer:local']);
});
test('image preview keeps original bytes, bounds dimensions and rejects SVG',async({page})=>{
  await page.getByRole('button',{name:'Add 👍 reaction'}).waitFor();
  const result=await page.evaluate(()=>(window as any).previewImage());
  expect(result).toMatchObject({width:480,height:320,sourceWidth:1200,sourceHeight:800,mime:'image/webp',originalUnchanged:true});
  expect(result.size).toBeLessThan(512*1024);
  expect(await page.evaluate(()=>(window as any).svgPreview())).toBeNull();
});
