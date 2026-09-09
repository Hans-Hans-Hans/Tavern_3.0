import { test, expect, type Page } from '@playwright/test';

// Real Chromium IndexedDB/WebCrypto and production outbox code. Only the Matrix
// client, upload and acknowledged-send boundaries are controlled by this fixture.
async function fixture(page: Page) {
  await page.route('**/__outbox-attachments', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Encrypted attachment outbox</title>' }));
  await page.goto('/__outbox-attachments');
  await page.evaluate(async () => {
    const m = await import('/lib/outbox.ts' as string), storage = await import('/lib/outbox-store.ts' as string);
    const f: any = (window as any).attachmentOutbox = { m, storage, actor: '@attachments:local', device: 'FILES', membership: 'join', owner: {}, uploads: [], sent: [], failures: [], roomId: '!files:local' };
    f.client = { getUserId: () => f.actor, getDeviceId: () => f.device, getHomeserverUrl: () => location.origin,
      getRoom: (id: string) => id === f.roomId ? { getMyMembership: () => f.membership } : undefined };
    f.until = async (condition: () => any) => { for (let i = 0; i < 300; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Outbox boundary did not complete'); };
    f.open = async () => { const owner = f.owner; await m.initializeOutbox(f.client, (item: any, cp: any) => f.send(item, cp), { current: () => f.owner === owner,
      upload: async (file: File, item: any, attachment: any) => {
        f.uploads.push({ id: attachment.id, itemId: item.id, bytes: await file.text(), name: file.name });
        if (f.uploadGate) await f.uploadGate;
        if (f.failUpload === attachment.id) throw new Error('Fixture upload is unavailable');
        const url = 'mxc://local/' + attachment.id;
        return { id: attachment.id, roomId: item.roomId, name: file.name, type: file.type, size: file.size, url, info: {},
          file: { url, v: 'v2', key: { kty: 'oct', alg: 'A256CTR', k: 'K'.repeat(43) }, iv: 'I'.repeat(22), hashes: { sha256: 'H'.repeat(43) } } };
      } }); };
    f.send = async (item: any, cp: any) => {
      await cp.prepare({ msgtype: 'm.text', body: item.body, 'm.mentions': {} }, true);
      for (const file of item.attachments || []) {
        if (file.eventId) continue;
        const descriptor = await cp.upload(file.id);
        f.sent.push({ id: file.id, transactionId: file.transactionId, url: descriptor.url });
        if (f.sendGate) await f.sendGate;
        await cp.attachment(file.id, file.transactionId, '$ack-' + file.id);
      }
      if (item.body && !item.bodyEventId) await cp.body('$body-' + item.id);
    };
    f.enqueue = async (id = 'batch', kind = 'draft', count = 2, due = Date.now()) => {
      const files = Array.from({ length: count }, (_, n) => new File(['private original bytes ' + n], 'secret-' + n + '.txt', { type: 'text/plain' }));
      const attachments = files.map((file, n) => ({ id: id + '-file-' + n, name: file.name, type: file.type, size: file.size, transactionId: id + '-f' + n }));
      return m.enqueueOutbox({ id, kind, roomId: f.roomId, body: 'private batch body', due, attachments }, new Map(attachments.map((file, n) => [file.id, files[n]])));
    };
    f.raw = async () => {
      const name = 'tavern-outbox-v1-' + encodeURIComponent(f.actor) + '-' + encodeURIComponent(f.device);
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try {
        const read = (store: string, key?: string) => new Promise<any>((resolve, reject) => { const table = db.transaction(store).objectStore(store), r = key ? table.get(key) : table.getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        return { messages: await read('messages'), files: await read('files'), key: await read('keys', 'encryption') };
      } finally { db.close(); }
    };
    await f.open();
  });
}

test.afterEach(async ({ page }) => { await page.evaluate(() => (window as any).attachmentOutbox?.m.resetOutbox()).catch(() => {}); });

test('an obsolete initializer cannot retire the replacement account outbox',async({page})=>{
  await fixture(page);
  const result=await page.evaluate(async()=>{
    const f=(window as any).attachmentOutbox;await f.enqueue('current-owner','draft',1);const owner=f.m.outboxOwner();let error='';
    try{await f.m.initializeOutbox(f.client,async()=>{throw new Error('Stale sender must not run');},{current:()=>false});}catch(e:any){error=e.message;}
    return {error,sameOwner:f.m.outboxOwner()===owner,items:(await f.m.readOutbox()).map((item:any)=>item.id)};
  });
  expect(result.error).toContain('earlier account');expect(result.sameOwner).toBe(true);expect(result.items).toEqual(['current-owner']);
});

test('real encrypted file and metadata records reopen without exposing content, filenames or descriptor keys', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).attachmentOutbox;
    await f.enqueue(); const raw = await f.raw(); f.m.resetOutbox(); await f.open(); const [restored] = await f.m.readOutbox();
    const bytes = (value: ArrayBuffer) => new TextDecoder().decode(value);
    const visible = JSON.stringify(raw.messages) + JSON.stringify(raw.files) + raw.messages.map((r: any) => bytes(r.ciphertext)).join('') + raw.files.map((r: any) => bytes(r.ciphertext)).join('');
    const sent = await f.m.deliverOutboxNow('batch'), after = await f.raw();
    return { visible, keyExtractable: raw.key.extractable, fileSizes: raw.files.map((r: any) => [r.size, r.ciphertext.byteLength]), restored, sent,
      uploads: f.uploads, remaining: after.messages.length + after.files.length };
  });
  expect(result.visible).not.toContain('private'); expect(result.visible).not.toContain('secret-'); expect(result.visible).not.toContain('KKKKKK');
  expect(result.keyExtractable).toBe(false); expect(result.fileSizes).toEqual([[24, 40], [24, 40]]);
  expect(result.restored.body).toBe('private batch body'); expect(result.restored.attachments.map((a: any) => a.name)).toEqual(['secret-0.txt', 'secret-1.txt']);
  expect(result.uploads.map((u: any) => u.bytes)).toEqual(['private original bytes 0', 'private original bytes 1']);
  expect(result.sent).toBe(true); expect(result.remaining).toBe(0);
});

test('queued wake preserves a first ACK and descriptor when the next upload fails, including reopen and explicit retry', async ({ page }) => {
  await fixture(page);
  const first = await page.evaluate(async () => {
    const f = (window as any).attachmentOutbox; f.failUpload = 'batch-file-1'; await f.enqueue('batch', 'queued');
    await f.until(async () => (await f.m.readOutbox())[0]?.failures === 1);
    const [item] = await f.m.readOutbox(), raw = await f.raw(); f.m.resetOutbox(); await f.open();
    let editError = ''; try { await f.m.editOutbox('batch', 'changed after attempted delivery', Date.now()); } catch (error: any) { editError = error.message; }
    return { item, fileIds: raw.files.map((r: any) => r.id), reopened: (await f.m.readOutbox())[0], editError,
      storedText: JSON.stringify(raw.messages) + raw.messages.map((r: any) => new TextDecoder().decode(r.ciphertext)).join('') };
  });
  expect(first.item.attempts).toBe(1); expect(first.item.failures).toBe(1); expect(first.item.attachments[0].eventId).toBe('$ack-batch-file-0');
  expect(first.item.attachments[0].descriptor.file.key.k).toBe('K'.repeat(43)); expect(first.item.attachments[1].eventId).toBeUndefined();
  expect(first.fileIds).toEqual(['batch-file-1']); expect(first.reopened).toEqual(first.item); expect(first.editError).toContain('already attempted');
  expect(first.storedText).not.toContain('K'.repeat(43)); expect(first.storedText).not.toContain('mxc://local/'); expect(first.storedText).not.toContain('secret-0.txt');
  const retried = await page.evaluate(async () => {
    const f = (window as any).attachmentOutbox; f.failUpload = undefined;
    let release!: () => void; f.uploadGate = new Promise<void>(r => { release = r; });
    await f.m.retryOutbox('batch'); await f.until(() => f.uploads.length === 3);
    const during = (await f.m.readOutbox())[0]; release();
    await f.until(async () => (await f.m.readOutbox()).length === 0); const raw = await f.raw();
    return { attempts: during.attempts, uploads: f.uploads.map((u: any) => u.id), sent: f.sent, remainingFiles: raw.files.length };
  });
  expect(retried.attempts).toBe(2); expect(retried.uploads).toEqual(['batch-file-0', 'batch-file-1', 'batch-file-1']);
  expect(retried.sent).toEqual([{ id: 'batch-file-0', transactionId: 'batch-f0', url: 'mxc://local/batch-file-0' }, { id: 'batch-file-1', transactionId: 'batch-f1', url: 'mxc://local/batch-file-1' }]);
  expect(retried.remainingFiles).toBe(0);
});

test('an ACK checkpoint write failure never lets the delivery catch overwrite the acknowledged in-memory revision', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).attachmentOutbox; await f.enqueue();
    const original = crypto.subtle.encrypt.bind(crypto.subtle); let injected = false;
    crypto.subtle.encrypt = async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      const value = JSON.parse(new TextDecoder().decode(args[2]));
      if (!injected && value.attachments?.[0]?.eventId) { injected = true; throw new DOMException('Fixture storage write failed', 'QuotaExceededError'); }
      return original(...args);
    };
    try { const delivered = await f.m.deliverOutboxNow('batch'); return { delivered, injected, item: (await f.m.readOutbox())[0], sent: f.sent }; }
    finally { crypto.subtle.encrypt = original; }
  });
  expect(result.delivered).toBe(false); expect(result.injected).toBe(true); expect(result.item.attachments[0].eventId).toBe('$ack-batch-file-0');
  expect(result.item.attachments[0].descriptor.url).toBe('mxc://local/batch-file-0'); expect(result.item.failures).toBe(1); expect(result.sent).toHaveLength(1);
});

test('cancel deletes only its owned ciphertext and aggregate quota failure aborts metadata and file writes atomically', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).attachmentOutbox; await f.enqueue('keep', 'draft', 1); await f.enqueue('cancel', 'draft', 1);
    await f.m.cancelOutbox('cancel'); const afterCancel = await f.raw(); f.m.resetOutbox();
    const store = await f.storage.OutboxStore.open(f.actor, f.device, location.origin, () => true);
    // Exercise the aggregate byte accounting at its boundary with declared
    // sizes, without allocating 100 MiB merely to test an IDB transaction abort.
    let quotaError = '';
    try {
      const record = await store.seal({ id: 'over-quota', due: Date.now(), body: 'must not persist' });
      await store.put(record, [{ id: 'over-quota-file', itemId: record.id, size: 100 * 1024 * 1024, iv: new Uint8Array(12), ciphertext: new ArrayBuffer(16) }]);
    } catch (error: any) { quotaError = error.message; } finally { store.close(); }
    const afterQuota = await f.raw(); await f.open();
    return { cancelMessages: afterCancel.messages.map((r: any) => r.id), cancelFiles: afterCancel.files.map((r: any) => r.id), quotaError,
      quotaMessages: afterQuota.messages.map((r: any) => r.id), quotaFiles: afterQuota.files.map((r: any) => r.id), body: (await f.m.readOutbox())[0].body };
  });
  expect(result.cancelMessages).toEqual(['keep']); expect(result.cancelFiles).toEqual(['keep-file-0']); expect(result.quotaError).toContain('100 MiB');
  expect(result.quotaMessages).toEqual(['keep']); expect(result.quotaFiles).toEqual(['keep-file-0']); expect(result.body).toBe('private batch body');
});

for (const boundary of ['encryption', 'storage'] as const) test(`owner replacement during ${boundary} cannot commit attachment records to the replacement session`, async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async boundary => {
    const f = (window as any).attachmentOutbox; let intercepted = false, error = '';
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle), getAll = IDBObjectStore.prototype.getAll;
    if (boundary === 'encryption') crypto.subtle.encrypt = async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      const value = await encrypt(...args); if (!intercepted) { intercepted = true; f.owner = {}; } return value;
    };
    else IDBObjectStore.prototype.getAll = function(...args: any[]) {
      const request = (getAll as any).apply(this, args);
      if (!intercepted && this.name === 'files' && this.transaction.mode === 'readwrite') request.addEventListener('success', () => { intercepted = true; f.owner = {}; });
      return request;
    };
    try { await f.enqueue('cancelled'); } catch (failure: any) { error = failure.message; }
    finally { crypto.subtle.encrypt = encrypt; IDBObjectStore.prototype.getAll = getAll; }
    const owner = f.m.outboxOwner(); f.m.resetOutbox(); await f.open(); const raw = await f.raw();
    return { intercepted, error, owner, messages: raw.messages.length, files: raw.files.length, deliveries: f.sent.length };
  }, boundary);
  expect(result.intercepted).toBe(true); expect(result.error).toContain('account changed'); expect(result.owner).toBeNull();
  expect(result.messages).toBe(0); expect(result.files).toBe(0); expect(result.deliveries).toBe(0);
});

for (const drift of ['room', 'account'] as const) test(`${drift} loss during upload prevents send and retains the original pending file and transaction`, async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async drift => {
    const f = (window as any).attachmentOutbox; await f.enqueue('pending', 'draft', 1);
    let release!: () => void; f.uploadGate = new Promise<void>(r => { release = r; });
    const sending = f.m.deliverOutboxNow('pending'); await f.until(() => f.uploads.length === 1);
    if (drift === 'room') f.membership = 'leave'; else { f.owner = {}; f.owner = {}; }
    release(); const success = await sending; f.m.resetOutbox(); f.membership = 'join'; await f.open();
    const item = (await f.m.readOutbox())[0], raw = await f.raw();
    return { success, sent: f.sent, item, files: raw.files.map((r: any) => r.id) };
  }, drift);
  expect(result.success).toBe(false); expect(result.sent).toEqual([]); expect(result.files).toEqual(['pending-file-0']);
  expect(result.item.attachments[0].descriptor).toBeUndefined(); expect(result.item.attachments[0].transactionId).toBe('pending-f0'); expect(result.item.attempts).toBe(1);
});

for (const drift of ['room', 'account'] as const) test(`${drift} loss while decrypting saved file bytes stops before upload`, async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async drift => {
    const f = (window as any).attachmentOutbox; await f.enqueue('decrypt', 'draft', 1);
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle); let intercepted = false;
    crypto.subtle.decrypt = async (...args: Parameters<SubtleCrypto['decrypt']>) => {
      const value = await decrypt(...args), algorithm = args[0] as AesGcmParams;
      if (algorithm.additionalData && new TextDecoder().decode(algorithm.additionalData).includes('tavern-outbox-file')) {
        intercepted = true; if (drift === 'room') f.membership = 'leave'; else f.owner = {};
      }
      return value;
    };
    let success: boolean;
    try { success = await f.m.deliverOutboxNow('decrypt'); } finally { crypto.subtle.decrypt = decrypt; }
    f.m.resetOutbox(); f.membership = 'join'; await f.open();
    return { success, intercepted, uploads: f.uploads, sent: f.sent, item: (await f.m.readOutbox())[0], files: (await f.raw()).files.length };
  }, drift);
  expect(result.intercepted).toBe(true); expect(result.success).toBe(false); expect(result.uploads).toEqual([]); expect(result.sent).toEqual([]);
  expect(result.item.attachments[0].transactionId).toBe('decrypt-f0'); expect(result.item.attachments[0].descriptor).toBeUndefined(); expect(result.files).toBe(1);
});

test('account A to B to A during native send cannot erase A pending lineage after an ambiguous acknowledgement', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).attachmentOutbox; await f.enqueue('ambiguous', 'draft', 1);
    let release!: () => void; f.sendGate = new Promise<void>(r => { release = r; });
    const sending = f.m.deliverOutboxNow('ambiguous'); await f.until(() => f.sent.length === 1);
    f.owner = {}; f.actor = '@other:local'; await f.open(); const other = await f.m.readOutbox();
    f.owner = {}; f.actor = '@attachments:local'; await f.open(); release(); const success = await sending;
    const [item] = await f.m.readOutbox(); return { success, other, item, raw: (await f.raw()).files.length, uploads: f.uploads.length };
  });
  expect(result.success).toBe(false); expect(result.other).toEqual([]); expect(result.item.id).toBe('ambiguous'); expect(result.item.attempts).toBe(1);
  expect(result.item.attachments[0].transactionId).toBe('ambiguous-f0'); expect(result.item.attachments[0].eventId).toBeUndefined();
  expect(result.item.attachments[0].descriptor.url).toBe('mxc://local/ambiguous-file-0'); expect(result.raw).toBe(0); expect(result.uploads).toBe(1);
});

test('a rejected blocked upgrade closes its eventual connection so the next upgrade can finish', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).attachmentOutbox, actor = '@blocked:local', device = 'UPGRADE';
    const name = 'tavern-outbox-v1-' + encodeURIComponent(actor) + '-' + device;
    const original = indexedDB.open.bind(indexedDB);
    const first = await new Promise<IDBDatabase>((resolve, reject) => { const r = original(name, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    let late: IDBDatabase | undefined, settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    indexedDB.open = ((database: string, version?: number) => {
      const request = version === undefined ? original(database) : original(database, version);
      if (database === name && version === 2) {
        request.addEventListener('success', () => { late = request.result; settle(); });
        request.addEventListener('error', () => settle());
      }
      return request;
    }) as IDBFactory['open'];
    let error = '';
    try {
      try { const unexpected = await f.storage.OutboxStore.open(actor, device, location.origin, () => true); unexpected.close(); }
      catch (failure: any) { error = failure.message; }
      first.close(); await settled;
      const next = await new Promise<string>((resolve, reject) => {
        const request = original(name, 3);
        request.onblocked = () => resolve('blocked');
        request.onsuccess = () => { request.result.close(); resolve('upgraded'); };
        request.onerror = () => reject(request.error);
      });
      return { error, next };
    } finally { indexedDB.open = original; first.close(); late?.close(); }
  });
  expect(result.error).toContain('Close another Tavern tab'); expect(result.next).toBe('upgraded');
});

test('reset cancels the pending drain timer and detaches online/visibility wake handlers while retaining saved files', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).attachmentOutbox, schedule = window.setTimeout.bind(window), cancel = window.clearTimeout.bind(window);
    const timers = new Map<number, number>();
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      const id = schedule(() => { timers.delete(id); if (typeof handler === 'function') handler(...args); }, timeout);
      timers.set(id, timeout || 0); return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = (id?: number) => { if (id !== undefined) timers.delete(id); cancel(id); };
    try {
      await f.enqueue('future', 'queued', 1, Date.now() + 60000);
      await f.until(() => [...timers.values()].some(value => value >= 1000));
      const before = [...timers.values()].filter(value => value >= 1000).length;
      f.m.resetOutbox(); window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange'));
      await new Promise<void>(resolve => schedule(resolve, 20));
      const after = [...timers.values()].filter(value => value >= 1000).length;
      const raw = await f.raw(); return { before, after, owner: f.m.outboxOwner(), uploads: f.uploads, sent: f.sent, files: raw.files.length };
    } finally { window.setTimeout = schedule; window.clearTimeout = cancel; }
  });
  expect(result.before).toBe(1); expect(result.after).toBe(0); expect(result.owner).toBeNull(); expect(result.uploads).toEqual([]); expect(result.sent).toEqual([]); expect(result.files).toBe(1);
});
