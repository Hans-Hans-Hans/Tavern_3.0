import type { MatrixClient } from 'matrix-js-sdk';

export type OutboxItem = { id: string; kind: 'scheduled' | 'queued' | 'reminder'; roomId: string; body: string; parent?: string; serverId?: string; eventId?: string; due: number; created: number; attempts: number; nextAttempt: number; error: string };
type RecordItem = { id: string; due: number; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };
type Session = { client: MatrixClient; db: IDBDatabase; key: CryptoKey; send: (item: OutboxItem) => Promise<unknown>; stop: () => void; timer?: ReturnType<typeof setTimeout>; running: boolean; generation: number };
let active: Session | null = null, generation = 0;
const watchers = new Set<() => void>(), encoder = new TextEncoder(), decoder = new TextDecoder();
const notify = () => watchers.forEach(fn => fn());
export function watchOutbox(fn: () => void) { watchers.add(fn); return () => { watchers.delete(fn); }; }
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error('Local storage update failed.')); });
const live = (s: Session) => active === s && s.generation === generation;
function session() { if (!active) throw new Error('Your encrypted outbox is still opening. Retry shortly.'); return active; }
async function seal(s: Session, value: OutboxItem): Promise<RecordItem> { const iv = crypto.getRandomValues(new Uint8Array(12)); return { id: value.id, due: value.due, iv, ciphertext: await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(value.id) }, s.key, encoder.encode(JSON.stringify(value))) }; }
async function open(s: Session, value: RecordItem): Promise<OutboxItem> { const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: value.iv, additionalData: encoder.encode(value.id) }, s.key, value.ciphertext); const result = JSON.parse(decoder.decode(raw)); if (result.id !== value.id) throw new Error('Outbox item could not be verified.'); return result; }
async function save(s: Session, item: OutboxItem) { const record = await seal(s, item); if (!live(s)) throw new Error('Your account changed.'); const tx = s.db.transaction('messages', 'readwrite'); tx.objectStore('messages').put(record); await done(tx); notify(); }
async function remove(s: Session, id: string) { if (!live(s)) return; const tx = s.db.transaction('messages', 'readwrite'); tx.objectStore('messages').delete(id); await done(tx); notify(); }
async function entries(s: Session) { const records = await request(s.db.transaction('messages').objectStore('messages').getAll()) as RecordItem[]; const values = await Promise.all(records.map(r => open(s, r))); return values.sort((a, b) => a.due - b.due); }
export async function readOutbox() { return entries(session()); }
export function validateOutboxItem(value: Pick<OutboxItem, 'kind' | 'body' | 'roomId' | 'due'>, now = Date.now()) { if (!['scheduled', 'queued', 'reminder'].includes(value.kind) || !value.roomId.startsWith('!') || !Number.isFinite(value.due) || value.due < now - 60000 || value.due > now + 366 * 86400000) throw new Error('Choose a conversation and a time within the next year.'); if (value.kind !== 'reminder' && (!value.body.trim() || value.body.length > 8000)) throw new Error('Scheduled text must contain 1–8,000 characters.'); }
export async function enqueueOutbox(value: Pick<OutboxItem, 'kind' | 'roomId' | 'body' | 'due'> & Partial<Pick<OutboxItem, 'parent' | 'serverId' | 'eventId' | 'id'>>) {
  validateOutboxItem(value); const s = session(); if (s.client.getRoom(value.roomId)?.getMyMembership() !== 'join') throw new Error('Join this conversation first.'); if ((await entries(s)).length >= 100) throw new Error('Your outbox holds up to 100 pending items. Clear completed or cancelled entries first.');
  const item: OutboxItem = { ...value, id: value.id || crypto.randomUUID(), created: Date.now(), attempts: 0, nextAttempt: value.due, error: '' }; await save(s, item); void wake(s).catch(()=>{}); return item;
}
async function changeOutbox<T>(fn:(s:Session)=>Promise<T>){const s=session();if(s.running)throw new Error('A delivery is in progress. Wait for it to finish before changing the outbox.');s.running=true;try{return await fn(s);}finally{s.running=false;void wake(s).catch(()=>{});}}
export async function cancelOutbox(id:string){return changeOutbox(s=>remove(s,id));}
export async function editOutbox(id:string,body:string,due:number){return changeOutbox(async s=>{const item=(await entries(s)).find(i=>i.id===id);if(!item)throw new Error('This item is no longer pending.');if(item.attempts)throw new Error('Delivery was already attempted. Check the conversation before cancelling and creating a replacement.');validateOutboxItem({...item,body,due});await save(s,{...item,body,due,nextAttempt:due,error:''});});}
export async function retryOutbox(id:string){return changeOutbox(async s=>{const item=(await entries(s)).find(i=>i.id===id);if(item)await save(s,{...item,nextAttempt:Date.now(),attempts:0,error:''});});}
async function wake(s: Session) {
  if (!live(s) || s.running) return; clearTimeout(s.timer); s.running = true;
  try {
    const list = await entries(s);
    for (const item of list) {
      if (!live(s)) return; if (item.nextAttempt > Date.now() || item.attempts >= 5) continue;
      if (item.kind === 'reminder') { window.dispatchEvent(new CustomEvent('tavern:reminder', { detail: item })); await save(s, { ...item, attempts: 5, error: 'Reminder due. Open the message or dismiss this reminder.' }); continue; }
      if (!navigator.onLine) continue;
      if (s.client.getRoom(item.roomId)?.getMyMembership() !== 'join') { await save(s, { ...item, attempts: 5, error: 'You no longer belong to this conversation.' }); continue; }
      try { await s.send(item); if (live(s)) await remove(s, item.id); }
      catch (e: any) { if (live(s)) await save(s, { ...item, attempts: item.attempts + 1, error: e.message || 'Delivery failed. Retry after reconnecting.', nextAttempt: Date.now() + Math.min(300000, 10000 * 2 ** item.attempts) }); }
    }
  } finally {
    s.running = false;
    if (live(s)) { const pending = (await entries(s)).filter(i => i.attempts < 5 && (navigator.onLine || i.kind === 'reminder')); if (pending.length) s.timer = setTimeout(() => void wake(s).catch(() => {}), Math.max(1000, Math.min(2147483647, Math.min(...pending.map(i => i.nextAttempt)) - Date.now()))); notify(); }
  }
}
export async function initializeOutbox(client: MatrixClient, send: Session['send']) {
  resetOutbox(); const current = generation, name = 'tavern-outbox-v1-' + encodeURIComponent(client.getUserId() || '') + '-' + encodeURIComponent(client.getDeviceId() || '');
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => { r.result.createObjectStore('keys'); r.result.createObjectStore('messages', { keyPath: 'id' }); }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  let key = await request(db.transaction('keys').objectStore('keys').get('encryption')) as CryptoKey;
  if (!key) { key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put(key, 'encryption'); await done(tx); }
  if (current !== generation) { db.close(); return; }
  const s: Session = { client, db, key, send, generation: current, running: false, stop: () => {} }; active = s;
  const online = () => void wake(s).catch(() => {}), visible = () => { if (!document.hidden) online(); }; window.addEventListener('online', online); document.addEventListener('visibilitychange', visible); s.stop = () => { window.removeEventListener('online', online); document.removeEventListener('visibilitychange', visible); }; await wake(s);
}
export function resetOutbox() { generation++; if (active) { const old = active; active = null; clearTimeout(old.timer); old.stop(); old.db.close(); } notify(); }
