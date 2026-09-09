import { createOrResumeBackup, discoverBackup } from './backup';
import { recoverLocalHistory, type LocalHistoryRecovery } from './local-history-recovery';
import type { MatrixClient } from 'matrix-js-sdk';
import { CryptoEvent, VerificationPhase, VerificationRequestEvent, VerifierEvent, decodeRecoveryKey,
  type CryptoCallbacks, type GeneratedSecretStorageKey, type VerificationRequest, type Verifier, type ShowSasCallbacks } from 'matrix-js-sdk/lib/crypto-api';

let client: MatrixClient | null = null;
const keys = new Map<string, Uint8Array<ArrayBuffer>>();
const retiredKeys:Uint8Array<ArrayBuffer>[]=[];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(fn => fn());
let request: VerificationRequest | null = null;
let sas: ShowSasCallbacks | null = null;
let verificationError = '';
let verifierCleanup: (() => void) | null = null;
let attachedVerifier: Verifier | null = null;
let generation = 0;
let sessionEpoch = 0;
let working = false;
let history: { busy: boolean; checked: boolean; local: LocalHistoryRecovery | null; error: string } = { busy: false, checked: false, local: null, error: '' };
export function historyRecoverySnapshot() { return history; }
export function securitySessionId() { return `${sessionEpoch}:${client?.getUserId() || ''}:${client?.getDeviceId() || ''}`; }
function owner(c: MatrixClient) {
  const epoch = sessionEpoch, user = c.getUserId(), device = c.getDeviceId();
  const current = () => c === client && epoch === sessionEpoch && c.getUserId() === user && c.getDeviceId() === device;
  return { current, check: () => { if (!current()) throw new Error('Your signed-in session changed. Retry from the current session.'); } };
}
export async function restoreLocalHistory() {
  const c = required(), own = owner(c);
  return exclusive(async () => {
    history = { ...history, busy: true, error: '' }; changed();
    try {
      const local = await recoverLocalHistory(c, own.current); own.check();
      history = { busy: false, checked: true, local, error: '' };
    } catch (error) {
      own.check(); history = { ...history, busy: false, checked: true, error: (error as Error).message };
    } finally { if (own.current()) { history = { ...history, busy: false }; changed(); } }
  });
}
/** Called after initial sync so the account's current recovery metadata is known. */
export async function prepareHistoryRecovery(c: MatrixClient) {
  const own = owner(c); own.check();
  await restoreLocalHistory(); own.check();
  // The SDK automatically fetches missing sessions when it has a backup key.
  // Recheck its cached key after sync, including keys received by verification.
  await c.getCrypto()!.checkKeyBackupAndEnable(); own.check(); changed();
}
export function securityOperationInProgress() { return working; }
function required() { if (!client?.getCrypto()) throw new Error('Sign in before managing encryption.'); return client; }
export function clearRecoveryKeys() { for (const key of [...keys.values(),...retiredKeys]) key.fill(0); keys.clear(); retiredKeys.length=0; }
export function cryptoCallbacks(getClient: () => MatrixClient): CryptoCallbacks {
  return {
    async getSecretStorageKey({ keys: available }) {
      if(client !== getClient()) return null;
      const id = await getClient().secretStorage.getDefaultKeyId();
      if(client !== getClient()) return null;
      return id && available[id] && keys.has(id) ? [id, keys.get(id)!] : null;
    },
    cacheSecretStorageKey(id, _info, key) { if(client !== getClient()) return; const old=keys.get(id);if(old)retiredKeys.push(old);keys.set(id, new Uint8Array(key)); },
  };
}
export function subscribeSecurity(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function verificationSnapshot() { return { request, sas, error: verificationError }; }
function attachVerifier(verifier: Verifier) {
  if (attachedVerifier === verifier) return;
  verifierCleanup?.(); attachedVerifier = verifier;
  const currentGeneration = generation;
  const show = (value: ShowSasCallbacks) => { if(attachedVerifier!==verifier)return; sas = value; changed(); };
  const cancel = () => { if(attachedVerifier!==verifier)return; sas = null; changed(); };
  verifier.on(VerifierEvent.ShowSas, show); verifier.on(VerifierEvent.Cancel, cancel);
  verifierCleanup = () => { verifier.off(VerifierEvent.ShowSas, show); verifier.off(VerifierEvent.Cancel, cancel); };
  const existing = verifier.getShowSasCallbacks(); if (existing) show(existing);
  void verifier.verify().then(() => { if (generation === currentGeneration && attachedVerifier === verifier) { sas = null; changed(); } }, e => {
    if (generation === currentGeneration && attachedVerifier === verifier) { verificationError = e.message || 'Verification was cancelled.'; sas = null; changed(); }
  });
}
function requestChanged() {
  if (!request) return;
  if (request.phase === VerificationPhase.Cancelled || request.phase === VerificationPhase.Done) { sas = null; verifierCleanup?.(); verifierCleanup = null; }
  else if (request.verifier) attachVerifier(request.verifier);
  changed();
}
function trackRequest(next: VerificationRequest) {
  if (request?.pending && request !== next) { void next.cancel().catch(() => {}); return; }
  dismissVerification(); request = next; request.on(VerificationRequestEvent.Change, requestChanged); requestChanged();
}
export function initializeSecurity(c: MatrixClient) {
  resetSecurity(); client = c;
  c.on(CryptoEvent.VerificationRequestReceived, trackRequest);
  for (const event of [CryptoEvent.KeysChanged, CryptoEvent.DevicesUpdated, CryptoEvent.UserTrustStatusChanged,
    CryptoEvent.KeyBackupStatus, CryptoEvent.KeyBackupFailed, CryptoEvent.KeyBackupDecryptionKeyCached]) c.on(event, changed);
}
export function resetSecurity() {
  sessionEpoch++; generation++; clearRecoveryKeys(); dismissVerification();
  history = { busy: false, checked: false, local: null, error: '' };
  if (client) {
    client.off(CryptoEvent.VerificationRequestReceived, trackRequest);
    for (const event of [CryptoEvent.KeysChanged, CryptoEvent.DevicesUpdated, CryptoEvent.UserTrustStatusChanged,
      CryptoEvent.KeyBackupStatus, CryptoEvent.KeyBackupFailed, CryptoEvent.KeyBackupDecryptionKeyCached]) client.off(event, changed);
  }
  client = null; changed();
}
export function dismissVerification() {
  generation++; request?.off(VerificationRequestEvent.Change, requestChanged); verifierCleanup?.();
  request = null; sas = null; verificationError = ''; verifierCleanup = null; attachedVerifier = null; changed();
}
export async function requestDeviceVerification(deviceId: string) {
  const c = required(), crypto = c.getCrypto()!, epoch = generation;
  await crypto.getUserDeviceInfo([c.getUserId()!], true);
  if (c !== client || epoch !== generation) return;
  const next = await crypto.requestDeviceVerification(c.getUserId()!, deviceId);
  if (c !== client || epoch !== generation) { await next.cancel().catch(() => {}); return; }
  trackRequest(next);
}
export async function requestPeerVerification(userId: string, roomId: string) {
  const c=required(),epoch=generation,next=await c.getCrypto()!.requestVerificationDM(userId,roomId);
  if(c!==client||epoch!==generation){await next.cancel().catch(()=>{});return;}trackRequest(next);
}
export async function acceptVerification() { await request?.accept(); }
export async function beginVerification() { const current=request,epoch=generation,c=client;if(!current)return;const verifier=await current.startVerification('m.sas.v1');if(current!==request||epoch!==generation||c!==client){await current.cancel().catch(()=>{});return;}attachVerifier(verifier); }
export async function confirmVerification(expected:ShowSasCallbacks) { if (sas!==expected)throw new Error('Verification changed. Compare the new emoji before confirming.'); if (!sas) throw new Error('No comparison is ready.'); const value = sas; sas = null; changed(); await value.confirm(); }
export function mismatchVerification() { sas?.mismatch(); sas = null; changed(); }
export async function cancelVerification() { const current=request,epoch=generation;await current?.cancel();if(current===request&&epoch===generation)dismissVerification(); }

export async function securityStatus() {
  const c = required(), crypto = c.getCrypto()!, own = owner(c);
  const [identity, crossSigning, storage, backupVersion, device, recovery, backup, serverIdentity] = await Promise.all([
    crypto.isCrossSigningReady(), crypto.getCrossSigningStatus(), crypto.isSecretStorageReady(),
    crypto.getActiveSessionBackupVersion(), crypto.getDeviceVerificationStatus(c.getUserId()!, c.getDeviceId()!),
    c.secretStorage.getKey(), discoverBackup(c), crypto.userHasCrossSigningKeys(c.getUserId()!),
  ]);
  own.check();
  const canRestoreBackup = backup ? (await crypto.isKeyBackupTrusted(backup)).matchesDecryptionKey : false;
  own.check();
  return { identity, crossSigning, storage, backupVersion, verified: device?.isVerified() ?? false, serverIdentity,
    recoveryConfigured: !!recovery, serverBackupVersion: backup?.version ?? null, canRestoreBackup };
}
async function exclusive<T>(operation: () => Promise<T>) {
  if (working) throw new Error('An encryption operation is already running.');
  working = true;
  try { return await operation(); } finally { working = false; clearRecoveryKeys(); changed(); }
}
export async function generateRecoveryKey() {
  const c = required(), crypto = c.getCrypto()!, own = owner(c);
  const [identity, storage, backup] = await Promise.all([
    crypto.userHasCrossSigningKeys(c.getUserId()!, true), c.secretStorage.getKey(), discoverBackup(c),
  ]);
  own.check();
  if (identity || storage || backup) throw new Error('This account already has encryption security configured. Recover it or verify with another device; Tavern will not replace your identity or backup.');
  const generated = await crypto.createRecoveryKeyFromPassphrase();
  if (!own.current()) { generated.privateKey.fill(0); own.check(); }
  return generated;
}
export async function setupRecovery(generated: GeneratedSecretStorageKey, password: string) {
  const owned = { ...generated, privateKey: new Uint8Array(generated.privateKey) };
  try { return await exclusive(async () => {
    const c = required(), crypto = c.getCrypto()!, own = owner(c);
    // Recheck after the user saves the key: another client may have configured the account.
    if (await crypto.userHasCrossSigningKeys(c.getUserId()!, true) || await c.secretStorage.getKey() || await discoverBackup(c))
      throw new Error('Security settings changed. Use recovery instead of overwriting existing keys.');
    own.check();
    await crypto.bootstrapSecretStorage({ createSecretStorageKey: async () => { own.check(); return owned; } }); own.check();
    await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: signingAuth(c, password) }); own.check();
    if(!await crypto.isCrossSigningReady())throw new Error('Identity setup is incomplete. Recover with the saved key and finish setup.');
    own.check(); await createOrResumeBackup(c, own.current); own.check();
  }); } finally { owned.privateKey.fill(0); }
}
function signingAuth(c: MatrixClient, password: string) {
  const own = owner(c);
  return async (makeRequest: (auth: any) => Promise<any>) => {
    own.check();
    try { await makeRequest(null); own.check(); } catch (error) {
      own.check();
      const e = error as any;
      if (e.httpStatus !== 401 || !e.data?.flows?.some((f: any) => f.stages.length === 1 && f.stages[0] === 'm.login.password')) throw error;
      if (!password) throw new Error('Your homeserver requires your account password to create the encryption identity.');
      await makeRequest({ type: 'm.login.password', identifier: { type: 'm.id.user', user: c.getUserId()! }, password, session: e.data.session });
      own.check();
    }
  };
}
export async function recoverEncryption(encoded: string, restoreAll: boolean, progress: (text: string) => void, finishSetup = false, password = '') {
  return exclusive(async () => {
    const c = required(), crypto = c.getCrypto()!, own = owner(c), storage = await c.secretStorage.getKey(); own.check();
    if (!storage) throw new Error('This account has no recovery key configured. Verify with another trusted device.');
    const [id, info] = storage;
    if (info.algorithm !== 'm.secret_storage.v1.aes-hmac-sha2') throw new Error('Unsupported secret storage format.');
    if(typeof info.mac !== 'string' || typeof info.iv !== 'string') throw new Error('This key has no authenticated recovery metadata. Verify with another trusted client.');
    const raw = decodeRecoveryKey(encoded.trim());
    try {
      if (!await c.secretStorage.checkKey(raw, info)) throw new Error('This recovery key does not match your account.');
      own.check();
      keys.set(id, raw);
      const hasIdentity = await crypto.userHasCrossSigningKeys(c.getUserId()!, true);
      own.check();
      const cross = await crypto.getCrossSigningStatus();
      own.check();
      if (hasIdentity) {
        if (!cross.privateKeysInSecretStorage && !Object.values(cross.privateKeysCachedLocally).every(Boolean))
          throw new Error('Your identity secrets are unavailable. Verify with a trusted device; your existing identity will be preserved.');
        progress('Unlocking encryption identity…'); await crypto.bootstrapCrossSigning({});
      } else {
        if (!finishSetup) throw new Error('No identity was published. Select Finish interrupted setup and enter your password to complete it using this recovery key.');
        // Explicit repair only when a fresh server query confirms no public identity exists.
        await crypto.bootstrapCrossSigning({ setupNewCrossSigning: true, authUploadDeviceSigningKeys: signingAuth(c, password) });
      }
      own.check();
      if(!await crypto.isCrossSigningReady())throw new Error('This device has not unlocked the current encryption identity. Verify it with another trusted device.');
      own.check(); await crypto.bootstrapSecretStorage({}); own.check();
      if(finishSetup) { await createOrResumeBackup(c, own.current); own.check(); }
      const backup = await discoverBackup(c); own.check();
      if (backup) {
        await crypto.loadSessionBackupPrivateKeyFromSecretStorage(); own.check(); await crypto.checkKeyBackupAndEnable(); own.check();
        if (restoreAll) { progress('Restoring encrypted history keys…'); await crypto.restoreKeyBackup({ progressCallback: value => { if (own.current()) progress(`Restoring keys: ${value.stage}`); } }); own.check(); }
      }
      const active = await crypto.getActiveSessionBackupVersion();
      own.check();
      progress(active ? 'Identity unlocked. Encrypted backup is active and restores missing keys automatically.' : 'Identity unlocked. No trusted backup is active; use Finish interrupted setup if a backup has never been created.');
    } finally { raw.fill(0); }
  });
}
