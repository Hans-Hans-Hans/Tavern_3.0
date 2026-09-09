import type { MatrixClient } from 'matrix-js-sdk';

export const cryptoStorePrefix = (userId: string, deviceId: string) => `harbor-crypto-${userId}-${deviceId}`;
export const cryptoStoreLock = (userId: string, deviceId: string) => `harbor-matrix-${userId}-${deviceId}`;
const databaseSuffix = '::matrix-sdk-crypto';
const maximumStores = 30, maximumKeys = 50000, maximumExportBytes = 32 * 1024 * 1024;
export type LocalHistoryRecovery = { stores: number; keys: number; skipped: number; limited: boolean; supported: boolean };

/** The old device is opened offline: no Matrix client, tokens, sync or outgoing
 * requests. Only room keys are copied; signing identities and device trust stay
 * with their original stores. Never delete a source store, even after success. */
export async function recoverLocalHistory(c: MatrixClient, isCurrent: () => boolean): Promise<LocalHistoryRecovery> {
  const userId = c.getUserId()!, deviceId = c.getDeviceId()!, crypto = c.getCrypto()!;
  const assertOwner = () => {
    if (!isCurrent() || c.getUserId() !== userId || c.getDeviceId() !== deviceId || c.getCrypto() !== crypto)
      throw new Error('Your signed-in session changed. Retry history recovery from the current session.');
  };
  assertOwner();
  const result: LocalHistoryRecovery = { stores: 0, keys: 0, skipped: 0, limited: false, supported: !!globalThis.indexedDB?.databases && !!globalThis.navigator?.locks };
  if (!result.supported) return result;
  const prefix = cryptoStorePrefix(userId, '');
  const databases = await indexedDB.databases(); assertOwner();
  const candidates = databases.flatMap(({name, version}) => {
    if (!name?.startsWith(prefix) || !name.endsWith(databaseSuffix) || !version) return [];
    const oldDevice = name.slice(prefix.length, -databaseSuffix.length);
    return oldDevice && oldDevice !== deviceId && oldDevice.length <= 255 ? [oldDevice] : [];
  }).sort();
  result.limited = candidates.length > maximumStores;
  if (!candidates.length) return result;
  const { initAsync, StoreHandle, OlmMachine, UserId, DeviceId } = await import('@matrix-org/matrix-sdk-crypto-wasm');
  await initAsync(); assertOwner();
  for (const oldDevice of candidates.slice(0, maximumStores)) {
    assertOwner();
    await navigator.locks.request(cryptoStoreLock(userId, oldDevice), { ifAvailable: true }, async lock => {
      assertOwner();
      if (!lock) { result.skipped++; return; }
      let store: Awaited<ReturnType<typeof StoreHandle.open>> | undefined;
      let machine: Awaited<ReturnType<typeof OlmMachine.initFromStore>> | undefined;
      let exported = '';
      try {
        // Recheck under the same lock used by normal sessions. Do not create a
        // missing database based on a stale enumeration.
        const name = cryptoStorePrefix(userId, oldDevice) + databaseSuffix;
        if (!(await indexedDB.databases()).some(db => db.name === name && db.version)) { result.skipped++; return; }
        assertOwner();
        store = await StoreHandle.open(cryptoStorePrefix(userId, oldDevice), undefined); assertOwner();
        // Rust rejects a stored account whose user/device differs from these IDs.
        machine = await OlmMachine.initFromStore(new UserId(userId), new DeviceId(oldDevice), store); assertOwner();
        const actualUser = machine.userId, actualDevice = machine.deviceId;
        try {
          if (actualUser.toString() !== userId || actualDevice.toString() !== oldDevice) throw new Error('The saved encryption account does not match.');
        } finally { actualUser.free(); actualDevice.free(); }
        let count = 0;
        exported = await machine.exportRoomKeys(() => { count++; return count <= maximumKeys; }); assertOwner();
        if (exported.length > maximumExportBytes) { result.skipped++; result.limited = true; return; }
        result.limited ||= count > maximumKeys;
        if (count) {
          await crypto.importRoomKeysAsJson(exported); assertOwner();
          result.keys += Math.min(count, maximumKeys);
        }
        result.stores++;
      } catch {
        assertOwner(); result.skipped++;
      } finally {
        exported = ''; machine?.close(); store?.free();
      }
    });
  }
  assertOwner(); return result;
}
