import { test, expect, type Page } from '@playwright/test';
async function prepare(page: Page) {
  await page.route('**/local-history-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><script type='module'>window.fixture=await(await import('/tests/browser/fixtures/local-history.ts')).fixture();</script></body></html>`}));
  await page.goto('/local-history-test'); await page.waitForFunction(()=>(window as any).fixture);
}
test('saved old-device keys recover a real encrypted event and SDK retries its failed decryption',async({page})=>{
  await prepare(page);
  expect(await page.evaluate(()=>(window as any).fixture.event.isDecryptionFailure())).toBe(true);
  const before=await page.evaluate(()=>(window as any).fixture.inspectOld());
  const result=await page.evaluate(()=>(window as any).fixture.repair());
  expect(result).toMatchObject({stores:1,keys:1,skipped:1,limited:false,supported:true});
  await expect.poll(()=>page.evaluate(()=>(window as any).fixture.event.getContent().body)).toBe('Saved message from OLD');
  expect(await page.evaluate(()=>(window as any).fixture.inspectOld())).toEqual(before);
  expect(await page.evaluate(()=>(window as any).fixture.decryptOther())).toBe(true);
  expect(await page.evaluate(async()=>{const c=(window as any).fixture.client;return (await c.getCrypto().getCrossSigningStatus()).privateKeysCachedLocally;})).toEqual({masterKey:false,selfSigningKey:false,userSigningKey:false});
});
test('an old session in another tab is skipped and can be recovered after it closes',async({page})=>{
  await prepare(page);await page.evaluate(async()=>{const w=window as any;w.release=await w.fixture.holdOld();});
  expect(await page.evaluate(()=>(window as any).fixture.repair())).toMatchObject({keys:0,skipped:2});
  await page.evaluate(()=>(window as any).release());
  expect(await page.evaluate(()=>(window as any).fixture.repair())).toMatchObject({keys:1,stores:1});
});
test('a session change during asynchronous database enumeration imports no history keys',async({page})=>{
  await prepare(page);
  const result=await page.evaluate(async()=>{const w=window as any,original=indexedDB.databases.bind(indexedDB);indexedDB.databases=async()=>{const values=await original();w.fixture.changeOwner();return values;};try{await w.fixture.repair();return 'unexpected';}catch(e){return (e as Error).message;}});
  expect(result).toMatch(/session changed/);
  expect(await page.evaluate(()=>(window as any).fixture.event.isDecryptionFailure())).toBe(true);
  expect(await page.evaluate(async()=>JSON.parse(await (window as any).fixture.client.getCrypto().exportRoomKeysAsJson()).length)).toBe(0);
});
