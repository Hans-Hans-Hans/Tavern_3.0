import { expect, test, type Page } from '@playwright/test';
async function fixture(page: Page) {
  await page.route('**/local-backup-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><script type='module'>window.fixture=await(await import('/tests/browser/fixtures/local-history.ts')).fixture();</script></body></html>`}));
  await page.goto('/local-backup-test'); await page.waitForFunction(()=>(window as any).fixture);
  await page.evaluate(()=>(window as any).fixture.seedBackup());
}
test('a new device reuses the server-matched existing Rust backup key without importing signing identity',async({page})=>{
  await fixture(page);
  expect(await page.evaluate(()=>(window as any).fixture.hasCachedBackup())).toBe(false);
  const result=await page.evaluate(()=>(window as any).fixture.repair());
  expect(result).toMatchObject({backupKeyRestored:true,keys:1,stores:1});
  expect(await page.evaluate(()=>(window as any).fixture.cachedBackupMatches())).toBe(true);
  const status=await page.evaluate(async()=>{const f=(window as any).fixture,c=f.client.getCrypto();await c.checkKeyBackupAndEnable();return {version:await c.getActiveSessionBackupVersion(),identity:await c.isCrossSigningReady(),keys:(await c.getCrossSigningStatus()).privateKeysCachedLocally};});
  expect(status).toEqual({version:'1',identity:false,keys:{masterKey:false,selfSigningKey:false,userSigningKey:false}});
  expect(await page.evaluate(()=>(window as any).fixture.inspectOld())).toMatchObject({keys:1});
});
for(const mismatch of ['version','publicKey','algorithm'])test(`an old cached backup with a different current ${mismatch} is preserved without automatic import`,async({page})=>{
  await fixture(page);
  await page.evaluate(kind=>{const f=(window as any).fixture,info=f.backupInfo();if(kind==='version')info.version='2';if(kind==='publicKey')info.auth_data.public_key='A'.repeat(43);if(kind==='algorithm')info.algorithm='unknown';f.setBackupInfo(info);},mismatch);
  expect(await page.evaluate(()=>(window as any).fixture.repair())).toMatchObject({keys:1});
  expect(await page.evaluate(()=>(window as any).fixture.hasCachedBackup())).toBe(false);
});
test('automatic recovery preserves a backup key already held by the new device',async({page})=>{
  await fixture(page);const before=await page.evaluate(()=>(window as any).fixture.seedCurrentBackup());
  await page.evaluate(()=>(window as any).fixture.repair());
  expect(await page.evaluate(()=>(window as any).fixture.cachedPublicKey())).toBe(before);
  expect(await page.evaluate(()=>(window as any).fixture.cachedBackupMatches())).toBe(false);
});

test('a key received by the new device during native metadata lookup is not overwritten',async({page})=>{
  await fixture(page);
  const result=await page.evaluate(async()=>{
    const f=(window as any).fixture;let received='';
    f.beforeBackup(async(count:number)=>{if(count===2)received=await f.seedCurrentBackup();});
    const recovered=await f.repair();return {received,actual:await f.cachedPublicKey(),restored:recovered.backupKeyRestored===true};
  });
  expect(result.actual).toBe(result.received);expect(result.restored).toBe(false);
});
test('native backup rotation during the final metadata await prevents caching the old key',async({page})=>{
  await fixture(page);
  await page.evaluate(()=>{const f=(window as any).fixture;f.beforeBackup((count:number)=>{if(count===2){const info=f.backupInfo();info.version='2';f.setBackupInfo(info);}});});
  await page.evaluate(()=>(window as any).fixture.repair());
  expect(await page.evaluate(()=>(window as any).fixture.hasCachedBackup())).toBe(false);
});

test('native rotation after a local cache write is not reported as restored or enabled',async({page})=>{
  await fixture(page);
  await page.evaluate(()=>{const f=(window as any).fixture;f.beforeBackup((count:number)=>{if(count===3){const info=f.backupInfo();info.version='2';info.auth_data.public_key='A'.repeat(43);f.setBackupInfo(info);}});});
  const result=await page.evaluate(()=>(window as any).fixture.repair());
  expect(result.backupKeyRestored).not.toBe(true);
  expect(await page.evaluate(()=>(window as any).fixture.cachedBackupMatches())).toBe(false);
  expect(await page.evaluate(async()=>{const c=(window as any).fixture.client.getCrypto();await c.checkKeyBackupAndEnable();return c.getActiveSessionBackupVersion();})).toBe(null);
});

test('a failed native recheck is attempted once across multiple matching old stores',async({page})=>{
  await fixture(page);
  await page.evaluate(async()=>{const f=(window as any).fixture;await f.copyBackupTo('ZZZ');f.beforeBackup((count:number)=>{if(count===2)throw new TypeError('Fixture transport failure');});});
  expect(await page.evaluate(()=>(window as any).fixture.repair())).toMatchObject({keys:1});
  expect(await page.evaluate(()=>(window as any).fixture.backupReadCount())).toBe(2);
  expect(await page.evaluate(()=>(window as any).fixture.hasCachedBackup())).toBe(false);
});

test('account retirement during the final native check does not cache an old-device backup key',async({page})=>{
  await fixture(page);
  await page.evaluate(()=>{const f=(window as any).fixture;f.beforeBackup((count:number)=>{if(count===2)f.changeOwner();});});
  const error=await page.evaluate(async()=>{try{await (window as any).fixture.repair();return null;}catch(error){return (error as Error).message;}});
  expect(error).toMatch(/session changed/);expect(await page.evaluate(()=>(window as any).fixture.hasCachedBackup())).toBe(false);
});
test('account retirement during backup discovery prevents key caching and local imports',async({page})=>{
  await fixture(page);
  await page.evaluate(()=>{const f=(window as any).fixture;f.beforeBackup(()=>f.changeOwner());});
  const error=await page.evaluate(async()=>{try{await (window as any).fixture.repair();return null;}catch(error){return (error as Error).message;}});
  expect(error).toMatch(/session changed/);expect(await page.evaluate(()=>(window as any).fixture.hasCachedBackup())).toBe(false);
  expect(await page.evaluate(()=>(window as any).fixture.event.isDecryptionFailure())).toBe(true);
});
