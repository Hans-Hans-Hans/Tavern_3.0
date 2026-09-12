import { accountArtworkOwner, isManagedAccount, requestApi } from './api';
import { getMatrixClient } from './matrix';
import { savedHistoryLogin as savedLogin } from './history-login';
import { Method, ClientPrefix } from 'matrix-js-sdk/lib/http-api';
import { discoverBackup } from './backup';
import { historyPasswordKey, wrapHistoryKey, unwrapHistoryKey, type HistoryEnvelope } from './history-envelope';
import { historyKeyOperation } from './security';
import { encodeBase64 } from 'matrix-js-sdk/lib/base64';
export type EmailHistoryStatus = { configured: boolean; revision: string | null; emailReady: boolean; credentialEpoch: number; passwordChanged: boolean; backupVersion: string | null };
function owner() {
  const client = getMatrixClient(), account = accountArtworkOwner();
  if (!client?.getCrypto() || !isManagedAccount()) throw new Error('Sign in to Tavern before recovering history.');
  const user = client.getUserId()!, device = client.getDeviceId(), base = client.getHomeserverUrl(), crypto = client.getCrypto()!;
  const current = () => getMatrixClient() === client && accountArtworkOwner() === account && client.getUserId() === user && client.getDeviceId() === device && client.getHomeserverUrl() === base && client.getCrypto() === crypto;
  const check = () => { if (!current()) throw new Error('Your signed-in device changed. Retry from the current session.'); };
  return { client, crypto, user, account, check, current };
}

export function hasHistoryLogin() { const c=getMatrixClient(); return !!c && !!savedLogin(c.getUserId()!,accountArtworkOwner()); }
export async function emailHistoryStatus(): Promise<EmailHistoryStatus> { const own=owner(); const value=await requestApi<EmailHistoryStatus>('/account/history'); own.check(); return value; }
export async function enableEmailHistory(password = '') {
  const own = owner();
  let secret = savedLogin(own.user, own.account);
  if (password) {
    const confirmed = await requestApi<{credentialEpoch:number}>('/account/history/password', { password }); own.check();
    const key = await historyPasswordKey(password); own.check();
    secret = { key, user: own.user, account: own.account, epoch: confirmed.credentialEpoch, expires: Date.now()+300000 };
  }
  if (!secret) throw new Error('Enter your account password to protect the saved history key.');
  const status = await emailHistoryStatus(); own.check();
  if (!status.emailReady) throw new Error('Verify your email address and ask your administrator to configure email delivery.');
  if (status.credentialEpoch !== secret.epoch) throw new Error('Your password changed. Enter your current password to protect history again.');
  const backup = await discoverBackup(own.client); own.check();
  if (!backup || backup.algorithm !== 'm.megolm_backup.v1.curve25519-aes-sha2' || !(await own.crypto.isKeyBackupTrusted(backup)).matchesDecryptionKey) throw new Error('Recover or set up your native history backup on this device first. Existing keys and backups will be preserved.');
  own.check();
  const bytes = await own.crypto.getSessionBackupPrivateKey();
  try {
    own.check(); if (!bytes) throw new Error('This device does not have your history backup key yet.');
    const copy=new Uint8Array(bytes);let value:HistoryEnvelope;
    try {value=await wrapHistoryKey(secret.key,own.user,location.origin,{version:backup.version,publicKey:backup.auth_data.public_key},copy);}finally{copy.fill(0);}
    own.check();
    await requestApi('/account/history',{package:value,revision:status.revision,credentialEpoch:secret.epoch}); own.check();
  } finally { bytes?.fill(0); }
}
export async function startEmailHistory() { const own=owner(); const value=await requestApi<{challengeId:string}>('/account/history/start',{}); own.check(); return value.challengeId; }
export async function recoverEmailHistory(challengeId: string, code: string, password = '') {
 return historyKeyOperation(async()=>{
  const own = owner(), remembered = savedLogin(own.user,own.account);
  const key = password ? await historyPasswordKey(password) : remembered?.key;
  own.check(); if (!key) throw new Error('Enter the password used to protect your history.');
  const value = await requestApi<{package:HistoryEnvelope}>('/account/history/complete',{challengeId,code}); own.check();
  const bytes = await unwrapHistoryKey(key,own.user,location.origin,value.package);
  try {
    own.check(); const {BackupDecryptionKey,initAsync}=await import('@matrix-org/matrix-sdk-crypto-wasm');await initAsync();own.check();
    const native=BackupDecryptionKey.fromBase64(encodeBase64(bytes)),pub=native.megolmV1PublicKey;
    try { if(pub.publicKeyBase64!==value.package.publicKey || pub.algorithm!=='m.megolm_backup.v1.curve25519-aes-sha2')throw new Error('The recovered key does not match the native history backup.'); }
    finally {pub.free();native.free();}
    const backup=await discoverBackup(own.client);own.check();
    if(backup?.version!==value.package.backupVersion||backup.auth_data.public_key!==value.package.publicKey||backup.algorithm!=='m.megolm_backup.v1.curve25519-aes-sha2')throw new Error('The backup changed during recovery. Retry with its current key.');
    await own.crypto.storeSessionBackupPrivateKey(bytes,backup.version);own.check();
    await own.crypto.checkKeyBackupAndEnable();own.check();
    await own.crypto.restoreKeyBackup();own.check();
  } finally {bytes.fill(0);}
 });
}

const starts=new WeakMap<object,Promise<string>>(), enrollments=new WeakMap<object,Promise<void>>();
export function autoStartEmailHistory() {
 const own=owner();let pending=starts.get(own.account);
 if(!pending){pending=startEmailHistory();starts.set(own.account,pending);}
 return pending;
}
export function autoEnableEmailHistory() {
 const own=owner();let pending=enrollments.get(own.account);
 if(!pending){pending=enableEmailHistory();enrollments.set(own.account,pending);}
 return pending;
}

/** Explicitly protect currently held room keys without deleting older backups
 * or changing the existing signing identity. Cache the candidate before POST;
 * an interrupted request can be adopted only if the native public key matches. */
export async function protectCurrentHistory(password: string) {
 const own=owner();
 await requestApi('/account/history/password',{password});own.check();
 await historyKeyOperation(async()=>{
  const status=await emailHistoryStatus();own.check();
  if(status.configured)throw new Error('Recover the existing email package before creating another backup.');
  if(!status.emailReady)throw new Error('Verify your email address and configure email delivery first.');
  const current=await discoverBackup(own.client);own.check();
  if(current&&(await own.crypto.isKeyBackupTrusted(current)).matchesDecryptionKey)return;
  own.check();
  const {BackupDecryptionKey,initAsync}=await import('@matrix-org/matrix-sdk-crypto-wasm');await initAsync();own.check();
  const journalKey='tavern.email-backup.pending:'+JSON.stringify([location.origin,own.user]);
  let journal:{publicKey:string;previousVersion:string|null;previousPublicKey:string|null}|null=null;
  try{journal=JSON.parse(localStorage.getItem(journalKey)||'null');}catch{throw new Error('Browser storage is unavailable. Restore storage before creating a backup.');}
  const cached=await own.crypto.getSessionBackupPrivateKey();own.check();
  const generated=cached?BackupDecryptionKey.fromBase64(encodeBase64(cached)):BackupDecryptionKey.createRandomKey(),pub=generated.megolmV1PublicKey;
  const bytes=cached?new Uint8Array(cached):Uint8Array.from(atob(generated.toBase64()),c=>c.charCodeAt(0));cached?.fill(0);
  try {
   if(cached&&(!journal||journal.publicKey!==pub.publicKeyBase64||journal.previousVersion!==(current?.version||null)||journal.previousPublicKey!==(current?.auth_data.public_key||null)))throw new Error('This browser holds another backup key. Recover or export it before creating a new backup.');
   const latestCached=await own.crypto.getSessionBackupPrivateKey();
   try{own.check();if(!!latestCached!==!!cached||(latestCached&&encodeBase64(latestCached)!==encodeBase64(bytes)))throw new Error('A history key arrived during setup. Retry without replacing it.');}finally{latestCached?.fill(0);}
   localStorage.setItem(journalKey,JSON.stringify({publicKey:pub.publicKeyBase64,previousVersion:current?.version||null,previousPublicKey:current?.auth_data.public_key||null}));
   // Retained Rust cache is the recovery journal if native POST has an uncertain outcome.
   await own.crypto.storeSessionBackupPrivateKey(bytes,'io.tavern.email.pending');own.check();
   const before=await discoverBackup(own.client);own.check();
   if(before?.version!==current?.version||before?.auth_data.public_key!==current?.auth_data.public_key)throw new Error('Another device changed the backup. Retry without replacing it.');
   const result=await own.client.http.authedRequest<{version:string}>(Method.Post,'/room_keys/version',undefined,{algorithm:pub.algorithm,auth_data:{public_key:pub.publicKeyBase64}},{prefix:ClientPrefix.V3});own.check();
   const latest=await discoverBackup(own.client);own.check();
   if(!result?.version||latest?.version!==result.version||latest.auth_data.public_key!==pub.publicKeyBase64)throw new Error('The backup changed during setup. The candidate key remains saved on this browser; older backups were preserved.');
   await own.crypto.storeSessionBackupPrivateKey(bytes,result.version);own.check();
   await own.crypto.checkKeyBackupAndEnable();own.check();
   localStorage.removeItem(journalKey);
  } finally {bytes.fill(0);pub.free();generated.free();}
 });
 await enableEmailHistory(password);own.check();
}
