import { outboxByteLimit, type EncryptedFileRecord } from './outbox-attachments';

export type StoredOutboxMessage = { id: string; due: number; version?: 2; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };
const encoder = new TextEncoder(), decoder = new TextDecoder();
const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const complete = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('The encrypted outbox update was interrupted.'));
});
export function outboxScope(actor: string, device: string, homeserver: string) {
  const url = new URL(homeserver);
  if (!actor.startsWith('@') || !device || url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('Your encrypted outbox needs a current Matrix account and device.');
  return JSON.stringify([actor, device, url.href.replace(/\/$/, '')]);
}
/** One Matrix session already holds the exclusive crypto-store Web Lock. Every
 * storage operation still fences its own account generation, including IDB
 * callbacks, so a late request cannot populate a replacement account's UI. */
export class OutboxStore {
  readonly key: CryptoKey;
  readonly scope: string;
  private database: IDBDatabase;
  private owned: () => boolean;
  private closed = false;
  private transactions = new Set<IDBTransaction>();
  private constructor(database: IDBDatabase, key: CryptoKey, scope: string, current: () => boolean) { this.database = database; this.key = key; this.scope = scope; this.owned = current; }
  current = () => !this.closed && this.owned();
  check() { if (!this.current()) throw new Error('Your account changed. Reopen the encrypted outbox.'); }
  static async open(actor: string, device: string, homeserver: string, current: () => boolean) {
    const scope = outboxScope(actor, device, homeserver), name = 'tavern-outbox-v1-' + encodeURIComponent(actor) + '-' + encodeURIComponent(device);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      let abandoned = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
        if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' }).createIndex('itemId', 'itemId');
      };
      request.onsuccess = () => { if(abandoned)request.result.close();else resolve(request.result); }; request.onerror = () => {abandoned=true;reject(request.error);};
      request.onblocked = () => {abandoned=true;reject(new Error('Close another Tavern tab before upgrading the encrypted outbox.'));};
    });
    try {
      if (!current()) throw new Error('Your account changed.');
      const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      if (!current()) throw new Error('Your account changed.');
      let key: CryptoKey = candidate, failure: Error | undefined;
      const transaction = database.transaction('keys', 'readwrite'), finished = complete(transaction), keys = transaction.objectStore('keys');
      const existingScope = keys.get('scope');
      existingScope.onsuccess = () => {
        if (!current() || existingScope.result !== undefined && existingScope.result !== scope) {
          failure = new Error('This saved outbox belongs to a different account gateway. Open it from its original homeserver.'); transaction.abort(); return;
        }
        const existing = keys.get('encryption');
        existing.onsuccess = () => {
          if (!current()) { failure = new Error('Your account changed.'); transaction.abort(); return; }
          if (existing.result) key = existing.result; else keys.put(candidate, 'encryption');
          // Existing v1 text records remain readable under their original key.
          // The first upgraded session fixes the previously implicit origin.
          if (existingScope.result === undefined) keys.put(scope, 'scope');
        };
      };
      try { await finished; } catch (error) { throw failure || error; }
      if (!current()) throw new Error('Your account changed.');
      return new OutboxStore(database, key, scope, current);
    } catch (error) { database.close(); throw error; }
  }
  close() {
    this.closed = true;
    for (const transaction of this.transactions) { try { transaction.abort(); } catch { /* Already completed. */ } }
    this.transactions.clear(); this.database.close();
  }
  private transaction(stores: string[], mode: IDBTransactionMode) {
    this.check(); const transaction = this.database.transaction(stores, mode); this.transactions.add(transaction);
    const finished = complete(transaction).finally(() => { this.transactions.delete(transaction); });
    // A request failure may finish the transaction before its caller awaits it.
    void finished.catch(() => {}); return { transaction, finished };
  }
  async records() {
    const { transaction, finished } = this.transaction(['messages'], 'readonly');
    const records = await result(transaction.objectStore('messages').getAll()) as StoredOutboxMessage[];
    await finished; this.check(); return records;
  }
  async file(itemId: string, id: string) {
    const { transaction, finished } = this.transaction(['files'], 'readonly');
    const record = await result(transaction.objectStore('files').get(id)) as EncryptedFileRecord | undefined;
    await finished; this.check();
    if (!record || record.itemId !== itemId) throw new Error('The original file is no longer saved on this device. Keep the draft and reattach it.');
    return record;
  }
  async seal(value: { id: string; due: number }) {
    this.check(); const bytes = encoder.encode(JSON.stringify(value));
    if (bytes.byteLength > 256 * 1024) throw new Error('The encrypted pending message metadata is too large.');
    const iv = crypto.getRandomValues(new Uint8Array(12)), ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify([2, this.scope, value.id])) }, this.key, bytes);
    this.check(); return { id: value.id, due: value.due, version: 2 as const, iv, ciphertext };
  }
  async open<T extends { id: string }>(record: StoredOutboxMessage): Promise<T> {
    this.check();
    if (record.version !== undefined && record.version !== 2 || !(record.ciphertext instanceof ArrayBuffer) || record.ciphertext.byteLength > 256 * 1024 + 16) throw new Error('The saved outbox format is invalid.');
    const additionalData = encoder.encode(record.version === 2 ? JSON.stringify([2, this.scope, record.id]) : record.id);
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData }, this.key, record.ciphertext);
    this.check(); const value = JSON.parse(decoder.decode(bytes));
    if (value.id !== record.id) throw new Error('The saved outbox item could not be verified.');
    return value;
  }
  async put(record: StoredOutboxMessage, files: EncryptedFileRecord[] = [], removeFileIds: string[] = []) {
    const { transaction, finished } = this.transaction(['messages', 'files'], 'readwrite'), messages = transaction.objectStore('messages'), store = transaction.objectStore('files');
    let failure: Error | undefined;
    const existing = store.getAll();
    existing.onsuccess = () => {
      try {
        this.check();
        const current = existing.result as EncryptedFileRecord[], byId = new Map(current.map(file => [file.id, file]));
        for (const id of removeFileIds) { if (byId.get(id)?.itemId !== record.id) throw new Error('A queued message cannot remove another message’s file.'); byId.delete(id); }
        for (const file of files) {
          if (file.itemId !== record.id || byId.has(file.id) && byId.get(file.id)!.itemId !== record.id) throw new Error('A saved file belongs to another pending message.');
          byId.set(file.id, file);
        }
        const bytes = [...byId.values()].reduce((total, file) => total + file.size, 0);
        if (!Number.isSafeInteger(bytes) || bytes > outboxByteLimit) throw new Error('The encrypted outbox holds up to 100 MiB of pending file copies. Cancel old items or keep the original files and retry while this view stays open.');
        messages.put(record); for (const id of removeFileIds) store.delete(id); for (const file of files) store.put(file);
      } catch (error) { failure = error as Error; transaction.abort(); }
    };
    try { await finished; } catch (error) { throw failure || error; }
    this.check();
  }
  async remove(id: string) {
    const { transaction, finished } = this.transaction(['messages', 'files'], 'readwrite');
    transaction.objectStore('messages').delete(id);
    const cursor = transaction.objectStore('files').index('itemId').openCursor(IDBKeyRange.only(id));
    cursor.onsuccess = () => { if (!this.current()) { transaction.abort(); return; } if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
    await finished; this.check();
  }
}
