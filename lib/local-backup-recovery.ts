import type { MatrixClient } from 'matrix-js-sdk';
import type { OlmMachine } from '@matrix-org/matrix-sdk-crypto-wasm';
import { decodeBase64 } from 'matrix-js-sdk/lib/base64';
import { discoverBackup } from './backup';

type Backup = { version: string; algorithm: string; publicKey: string };
function metadata(value: Awaited<ReturnType<typeof discoverBackup>>): Backup | null {
  return value && typeof value.version === 'string' && /^[^\s\x00-\x1f\x7f]{1,255}$/.test(value.version) &&
    value.algorithm === 'm.megolm_backup.v1.curve25519-aes-sha2' && typeof value.auth_data?.public_key === 'string' &&
    /^[A-Za-z0-9+/]{43}=?$/.test(value.auth_data.public_key)
    ? { version: value.version, algorithm: value.algorithm, publicKey: value.auth_data.public_key } : null;
}
const same = (a: Backup | null, b: Backup | null) => !!a && !!b && a.version === b.version && a.algorithm === b.algorithm && a.publicKey === b.publicKey;
async function currentBackup(c: MatrixClient): Promise<Backup | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return metadata(await Promise.race([discoverBackup(c), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Recovery metadata is unavailable.')), 8000); })])); }
  finally { clearTimeout(timer); }
}

/** Reuse a key already held in an offline same-account Rust store. Public SDK
 * storage APIs only; no signing secrets, trust changes, backup creation/deletion,
 * or additional plaintext persistence. Missing network metadata is optional. */
export async function localBackupRecovery(c: MatrixClient, isCurrent: () => boolean) {
  const crypto = c.getCrypto()!, user = c.getUserId(), device = c.getDeviceId(), base = c.getHomeserverUrl();
  const check = () => { if (!isCurrent() || c.getCrypto() !== crypto || c.getUserId() !== user || c.getDeviceId() !== device || c.getHomeserverUrl() !== base) throw new Error('Your signed-in session changed. Retry history recovery from the current session.'); };
  let target: Backup | null = null, finished = false;
  const targetHasKey = async () => {
    const key = await crypto.getSessionBackupPrivateKey();
    try { check(); return key !== null; } finally { key?.fill(0); }
  };
  try { check(); if (await targetHasKey()) finished = true; else { target = await currentBackup(c); check(); } }
  catch { check(); finished = true; }
  return async (machine: OlmMachine): Promise<boolean> => {
    check(); if (finished || !target) return false;
    let bundle: Awaited<ReturnType<OlmMachine['getBackupKeys']>> | undefined;
    let key: NonNullable<typeof bundle>['decryptionKey'];
    let publicKey: NonNullable<typeof key>['megolmV1PublicKey'] | undefined;
    let bytes: Uint8Array | undefined;
    try {
      bundle = await machine.getBackupKeys(); check(); key = bundle.decryptionKey;
      if (!key || bundle.backupVersion !== target.version) return false;
      publicKey = key.megolmV1PublicKey;
      if (publicKey.algorithm !== target.algorithm || publicKey.publicKeyBase64 !== target.publicKey) return false;
      // Attempt a matching candidate only once. Unavailable native metadata or
      // cache writes must not multiply network waits across every old store.
      finished = true;
      // Preserve a key already received by verification/recovery in this new
      // device, including a different version retained for older history.
      if (await targetHasKey()) { finished = true; return false; }
      const latest = await currentBackup(c); check();
      if (!same(target, latest)) { finished = true; return false; }
      if (await targetHasKey()) { finished = true; return false; }
      bytes = decodeBase64(key.toBase64());
      if (bytes.length !== 32) return false;
      check(); await crypto.storeSessionBackupPrivateKey(bytes, target.version); check(); finished = true;
      const after = await currentBackup(c); check();
      // A concurrent native backup rotation cannot be atomic with local IDB.
      // The SDK also checks version/key before enabling or restoring anything.
      return same(target, after);
    } catch { check(); return false; }
    finally { bytes?.fill(0); publicKey?.free(); key?.free(); bundle?.free(); }
  };
}
