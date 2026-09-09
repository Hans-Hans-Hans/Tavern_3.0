import { test, expect, type Page } from '@playwright/test';
async function fixture(page: Page, configured = true) {
  await page.route(url=>url.pathname==='/lib/matrix.ts',route=>route.fulfill({contentType:'text/javascript',body:`
    const client={getUserId:()=> '@alice:local',getDeviceId:()=> 'NEW',getCrypto:()=>({getOwnDeviceKeys:async()=>({ed25519:'public fingerprint'}),getDeviceVerificationStatus:async()=>null}),getDevices:async()=>({devices:[]})};
    export const getMatrixClient=()=>client;export const onMatrixUpdate=()=>()=>{};export const revokeMatrixDevice=async()=>{};export const importEncryptionKeys=async()=>{};` }));
  await page.route(url=>url.pathname==='/lib/security.ts',route=>route.fulfill({contentType:'text/javascript',body:`
    let configured=${configured},unlocked=false,session='1';const listeners=new Set();
    export const securitySessionId=()=>session;
    export const securityStatus=async()=>({identity:unlocked,verified:unlocked,storage:configured,serverIdentity:configured,recoveryConfigured:configured,serverBackupVersion:configured?'1':null,backupVersion:unlocked?'1':null,canRestoreBackup:unlocked});
    export const historyRecoverySnapshot=()=>({busy:false,checked:true,local:{stores:0,keys:0,skipped:0,supported:true},error:''});
    export const subscribeSecurity=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
    export const restoreLocalHistory=async()=>{};
    export const generateRecoveryKey=async()=>({privateKey:new Uint8Array(32),encodedPrivateKey:'test fixture recovery key'});
    export const setupRecovery=async()=>{configured=true;unlocked=true;listeners.forEach(fn=>fn());};
    export const recoverEncryption=async(key,all,progress)=>{window.recoveryArguments={key,all};if(key==='wrong')throw new Error('This recovery key does not match your account.');unlocked=true;progress('Encrypted history restored.');listeners.forEach(fn=>fn());};
    export const verificationSnapshot=()=>({});
    export const acceptVerification=()=>{},beginVerification=()=>{},cancelVerification=()=>{},confirmVerification=()=>{},dismissVerification=()=>{},mismatchVerification=()=>{},requestDeviceVerification=()=>{};
    window.changeSecuritySession=()=>{session='2';listeners.forEach(fn=>fn());};` }));
  await page.route('**/history-recovery-ui-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta name='viewport' content='width=device-width, initial-scale=1'></head><body><div id='root'></div><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/history-recovery.tsx')).mountFixture();</script></body></html>`}));
  await page.goto('/history-recovery-ui-test');await page.getByRole('button',{name:'History recovery',exact:true}).click();
}
test('new-device recovery is visible, restores all keys by default, and preserves setup after a wrong key',async({page})=>{
  await page.setViewportSize({width:390,height:640});await fixture(page);
  const dialog=page.getByRole('dialog',{name:'Recover and protect your messages'});
  await expect(dialog.getByRole('button',{name:'Set up a recovery key',exact:true})).toBeDisabled();
  await expect(dialog.getByLabel('Restore every available history key now')).toBeChecked();
  await dialog.getByLabel('Existing recovery key').fill('wrong');await dialog.getByRole('button',{name:'Unlock & enable automatic recovery'}).click();
  await expect(dialog.getByRole('alert')).toContainText('does not match');await expect(dialog.getByLabel('Existing recovery key')).toHaveValue('');
  await dialog.getByLabel('Existing recovery key').fill('fixture-key');await dialog.getByRole('button',{name:'Unlock & enable automatic recovery'}).click();
  await expect(dialog.getByRole('status')).toHaveText('Encrypted history restored.');
  expect(await page.evaluate(()=>(window as any).recoveryArguments)).toEqual({key:'fixture-key',all:true});
  await expect(page.getByRole('complementary',{name:'Encrypted history recovery'})).toHaveCount(0);
  expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
});
test('first-time recovery requires saving the generated key and clears entered secrets on session change',async({page})=>{
  await fixture(page,false);
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByLabel('Existing recovery key')).toHaveCount(0);
  await dialog.getByRole('button',{name:'Set up a recovery key',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Enable identity & backup'})).toBeDisabled();
  await dialog.getByLabel('I saved this key in a safe place.').check();
  await dialog.getByLabel('Account password',{exact:true}).fill('temporary password');
  await page.evaluate(()=>(window as any).changeSecuritySession());
  await expect(dialog.getByLabel('Recovery key',{exact:true})).toHaveCount(0);
  await expect(dialog.getByLabel('Account password',{exact:true})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:'Set up a recovery key',exact:true})).toBeVisible();
});
