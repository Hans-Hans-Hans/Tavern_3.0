import { test, expect } from '@playwright/test';
test('outbox encrypts drafts, persists schedules and excludes cancelled deliveries', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const m = await import('/lib/outbox.ts' as string), sent: any[] = [], room = { getMyMembership: () => 'join' }, client = { getUserId: () => '@test:local', getDeviceId: () => 'OUTBOX', getRoom: () => room };
    await m.initializeOutbox(client, async (item: any) => { sent.push(item); });
    const scheduled = await m.enqueueOutbox({ kind: 'scheduled', roomId: '!room:local', body: 'private scheduled text', due: Date.now() + 3600000 });
    await new Promise(r => setTimeout(r, 30));
    const databases = await indexedDB.databases(), dbName = databases.find(d => d.name?.startsWith('tavern-outbox-v1-'))!.name!;
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(dbName); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const records = await new Promise<any[]>((resolve, reject) => { const r = db.transaction('messages').objectStore('messages').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const key = await new Promise<CryptoKey>(resolve => { const r = db.transaction('keys').objectStore('keys').get('encryption'); r.onsuccess = () => resolve(r.result); }); db.close();
    m.resetOutbox(); await m.initializeOutbox(client, async (item: any) => { sent.push(item); }); const restored = await m.readOutbox();
    await m.editOutbox(scheduled.id, 'edited private text', Date.now() + 7200000); await new Promise(r => setTimeout(r, 30)); await m.cancelOutbox(scheduled.id); await new Promise(r => setTimeout(r, 30));
    const delivery = await m.enqueueOutbox({ kind: 'queued', roomId: '!room:local', body: 'deliver once', due: Date.now() });
    for (let i = 0; i < 100 && !sent.length; i++) await new Promise(r => setTimeout(r, 10));
    await new Promise(r => setTimeout(r, 20)); const remaining = await m.readOutbox(); m.resetOutbox();
    return { persisted: restored[0]?.body, plaintext: JSON.stringify(records).includes('private scheduled text'), keyExtractable: key.extractable, deliveries: sent.map(i => ({ id: i.id, body: i.body })), expectedId: delivery.id, remaining: remaining.length };
  });
  expect(result.persisted).toBe('private scheduled text'); expect(result.plaintext).toBe(false); expect(result.keyExtractable).toBe(false); expect(result.deliveries).toEqual([{ id: result.expectedId, body: 'deliver once' }]); expect(result.remaining).toBe(0);
});
