import type { MatrixClient } from 'matrix-js-sdk';
import { OutboxStore } from './outbox-store';
import { acknowledgeAttachment, openOutboxFile, sealOutboxFile, validateQueuedAttachments, type EncryptedFileRecord, type QueuedAttachment, type UploadedAttachment } from './outbox-attachments';

export type OutboxItem = {
  id: string; kind: 'scheduled' | 'queued' | 'reminder' | 'draft'; roomId: string; body: string;
  parent?: string; serverId?: string; eventId?: string; due: number; created: number;
  attempts: number; failures?: number; nextAttempt: number; error: string;
  attachments?: QueuedAttachment[]; bodyEventId?: string; preparedContent?: Record<string, any>; preparedRoleUsers?: string[]; encrypted?: boolean;
};
export type OutboxCheckpoint = {
  prepare: (content: Record<string, any>, encrypted: boolean, roleUsers?: string[]) => Promise<void>;
  upload: (id: string, validate?: () => void) => Promise<UploadedAttachment>;
  attachment: (id: string, transactionId: string, eventId: string) => Promise<void>;
  body: (eventId: string) => Promise<void>;
};
type Options = { current?: () => boolean; upload?: (file: File, item: OutboxItem, attachment: QueuedAttachment) => Promise<UploadedAttachment>; cancelled?: (id:string) => void };
type Sender = (item: OutboxItem, checkpoint: OutboxCheckpoint) => Promise<unknown>;
type Session = { client: MatrixClient; actor: string; device: string; homeserver: string; store: OutboxStore; send: Sender; options: Options; stop: () => void; timer?: ReturnType<typeof setTimeout>; running: boolean; generation: number };
type NewItem = Pick<OutboxItem, 'kind' | 'roomId' | 'body' | 'due'> & Partial<Pick<OutboxItem, 'parent' | 'serverId' | 'eventId' | 'id' | 'attachments' | 'preparedContent' | 'preparedRoleUsers' | 'encrypted' | 'bodyEventId'>> & {attempted?:boolean};
let active: Session | null = null, generation = 0;
const watchers = new Set<() => void>();
const notify = () => watchers.forEach(fn => fn());
const server = (client: MatrixClient) => client.getHomeserverUrl?.() || location.origin;
const live = (s: Session) => active === s && s.generation === generation && s.client.getUserId() === s.actor && s.client.getDeviceId() === s.device && server(s.client) === s.homeserver && (s.options.current?.() ?? true);
function check(s: Session) { if (!live(s)) throw new Error('Your account changed. Reopen the encrypted outbox.'); }
function session() { if (!active) throw new Error('Your encrypted outbox is still opening. Retry shortly.'); check(active); return active; }
export function outboxOwner(): object | null { return active && live(active) ? active : null; }
export function watchOutbox(fn: () => void) { watchers.add(fn); return () => { watchers.delete(fn); }; }
async function entries(s: Session) {
  check(s); const records = await s.store.records();
  const values = await Promise.all(records.map(record => s.store.open<OutboxItem>(record)));
  check(s);
  for (const item of values) {
    if (!item || !['scheduled', 'queued', 'reminder', 'draft'].includes(item.kind) || typeof item.roomId !== 'string' || !item.roomId.startsWith('!') || typeof item.body !== 'string' || item.body.length > 8000
      || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || !Number.isFinite(item.due) || !Number.isFinite(item.nextAttempt)) throw new Error('A saved outbox item is invalid. Keep its original draft before clearing local storage.');
    if (item.attachments) validateQueuedAttachments(item.attachments, item.roomId);
  }
  return values.sort((a, b) => a.due - b.due);
}
export async function readOutbox() { return entries(session()); }
async function save(s: Session, item: OutboxItem, files: EncryptedFileRecord[] = [], removeFiles: string[] = []) {
  check(s); const record = await s.store.seal(item); check(s);
  await s.store.put(record, files, removeFiles); check(s); notify();
}
async function remove(s: Session, id: string) { check(s); await s.store.remove(id); check(s); notify(); }
export function validateOutboxItem(value: Pick<OutboxItem, 'kind' | 'body' | 'roomId' | 'due'> & Partial<Pick<OutboxItem, 'attachments'>>, now = Date.now()) {
  if (!['scheduled', 'queued', 'reminder', 'draft'].includes(value.kind) || typeof value.roomId !== 'string' || !value.roomId.startsWith('!')
    || !Number.isFinite(value.due) || value.due < now - 60000 || value.due > now + 366 * 86400000) throw new Error('Choose a conversation and a time within the next year.');
  if (typeof value.body !== 'string' || value.body.length > 8000 || value.kind !== 'reminder' && !value.body.trim() && !value.attachments?.length) throw new Error('Keep a message of up to 8,000 characters or at least one attachment.');
  if (value.attachments) validateQueuedAttachments(value.attachments, value.roomId);
  if (value.kind === 'reminder' && value.attachments?.length) throw new Error('Message reminders do not contain pending attachments.');
}
async function change<T>(s: Session, task: () => Promise<T>) {
  check(s); if (s.running) throw new Error('A delivery is in progress. Wait for its acknowledgement before changing this outbox.');
  s.running = true;
  try { return await task(); }
  finally { s.running = false; if (live(s)) setTimeout(() => void wake(s).catch(() => {}), 0); }
}
export async function enqueueOutbox(value: NewItem, files: ReadonlyMap<string, File> = new Map()) {
  validateOutboxItem(value); const s = session();
  return change(s, async () => {
    if (s.client.getRoom(value.roomId)?.getMyMembership() !== 'join') throw new Error('Join this conversation first.');
    const list = await entries(s); check(s);
    const id = value.id || crypto.randomUUID();
    if (typeof id !== 'string' || !id || id.length > 220 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('The pending message transaction is invalid.');
    if (list.some(item => item.id === id)) throw new Error('This message is already saved in the outbox. Open its existing entry to retry or cancel it.');
    if (list.length >= 100) throw new Error('Your outbox holds up to 100 pending items. Cancel old entries first.');
    const {attempted,...draft}=value;
    const item: OutboxItem = structuredClone({ ...draft, id, created: Date.now(), attempts: attempted ? 1 : 0, failures: 0, nextAttempt: value.due, error: '' });
    const records: EncryptedFileRecord[] = [];
    for (const attachment of item.attachments || []) {
      if (attachment.descriptor) continue;
      const file = files.get(attachment.id);
      if (!file) throw new Error('Keep the original file and attach it before saving this retry.');
      records.push(await sealOutboxFile(s.store.key, s.store.scope, id, attachment, file, () => live(s)));
    }
    check(s); if (s.client.getRoom(item.roomId)?.getMyMembership() !== 'join') throw new Error('Your conversation membership changed.');
    await save(s, item, records); return structuredClone(item);
  });
}
export async function cancelOutbox(id: string) { const s = session(); return change(s, async () => {await remove(s,id);check(s);s.options.cancelled?.(id);}); }
export async function editOutbox(id: string, body: string, due: number) {
  const s = session(); return change(s, async () => {
    const item = (await entries(s)).find(value => value.id === id);
    if (!item) throw new Error('This item is no longer pending.');
    if (item.attempts || item.preparedContent || item.bodyEventId || item.attachments?.some(file => file.eventId)) throw new Error('Delivery was already attempted. Its original content and transaction must stay unchanged; check the conversation before cancelling and creating a replacement.');
    validateOutboxItem({ ...item, body, due });
    await save(s, { ...item, body, due, nextAttempt: due, error: '' });
  });
}
export async function retryOutbox(id: string) {
  const s = session(); return change(s, async () => {
    const item = (await entries(s)).find(value => value.id === id);
    if (!item) throw new Error('This pending message is no longer in the outbox. Open the conversation to check its status.');
    if (item.kind === 'reminder') return;
    // attempts is permanent lineage. Only the bounded backoff cycle resets.
    await save(s, { ...item, kind: item.kind === 'draft' ? 'queued' : item.kind, failures: 0, nextAttempt: Date.now(), error: '' });
  });
}
function joined(s: Session, item: OutboxItem) { check(s); if (s.client.getRoom(item.roomId)?.getMyMembership() !== 'join') throw new Error('You no longer belong to this conversation. The unsent files stay on this device until you cancel them.'); }
async function deliver(s: Session, original: OutboxItem) {
  let item = structuredClone(original);
  const checkpoint = async (next: OutboxItem, removeFiles: string[] = []) => {
    // Preserve an ACK even if its first local write fails; catch must never
    // overwrite it with the originally loaded, pre-delivery snapshot.
    item = next; await save(s, item, [], removeFiles);
  };
  try {
    joined(s, item);
    await checkpoint({ ...item, attempts: item.attempts + 1, error: '' });
    const controls: OutboxCheckpoint = {
      prepare: async (content, encrypted, roleUsers = []) => {
        joined(s, item);
        if (typeof encrypted !== 'boolean' || !content || typeof content !== 'object' || Array.isArray(content)) throw new Error('The pending message could not be prepared safely.');
        if (item.preparedContent && (JSON.stringify(item.preparedContent) !== JSON.stringify(content) || item.encrypted !== encrypted || JSON.stringify(item.preparedRoleUsers || []) !== JSON.stringify(roleUsers))) throw new Error('The message content, role recipients or encryption changed after its first attempt. Check the conversation before replacing this pending message.');
        if (!item.preparedContent) await checkpoint({ ...item, preparedContent: structuredClone(content), preparedRoleUsers: [...roleUsers], encrypted });
      },
      upload: async (id, validate) => {
        joined(s, item);validate?.();
        const attachment = item.attachments?.find(value => value.id === id);
        if (!attachment) throw new Error('This file is not part of the pending message.');
        if (attachment.descriptor) return structuredClone(attachment.descriptor);
        if (!item.preparedContent || !s.options.upload) throw new Error('File retry must prepare the message and current permissions before uploading.');
        const record = await s.store.file(item.id, attachment.id);
        const file = await openOutboxFile(s.store.key, s.store.scope, item.id, attachment, record, () => live(s));
        joined(s, item);validate?.();
        const uploaded = await s.options.upload(file, structuredClone(item), structuredClone(attachment));
        joined(s, item);validate?.();
        const descriptor = { ...uploaded, id: attachment.id }, attachments = item.attachments!.map(value => value.id === attachment.id ? { ...value, descriptor } : value);
        validateQueuedAttachments(attachments, item.roomId);
        await checkpoint({ ...item, attachments }, [attachment.id]);
        return structuredClone(descriptor);
      },
      attachment: async (id, transactionId, eventId) => { check(s); await checkpoint({ ...item, attachments: acknowledgeAttachment(item.attachments || [], id, transactionId, eventId) }); },
      body: async eventId => {
        check(s);
        if (typeof eventId !== 'string' || !eventId.startsWith('$') || item.bodyEventId && item.bodyEventId !== eventId) throw new Error('The homeserver returned a conflicting message acknowledgement.');
        await checkpoint({ ...item, bodyEventId: eventId });
      },
    };
    await s.send(structuredClone(item), controls);
    check(s);
    if (item.attachments?.some(file => !file.eventId)) throw new Error('Some attachments were not acknowledged. Their original transactions stay available for retry.');
    await remove(s, item.id); return true;
  } catch (error: any) {
    if (live(s)) await save(s, { ...item, failures: (item.failures || 0) + 1, error: error?.message || 'Delivery was not confirmed. Check the conversation or retry.', nextAttempt: Date.now() + Math.min(300000, 10000 * 2 ** Math.min(10, item.failures || 0)) });
    return false;
  }
}
/** A manual retry of a parked draft stays parked after failure. */
export async function deliverOutboxNow(id: string) {
  const s = session(); return change(s, async () => {
    const item = (await entries(s)).find(value => value.id === id);
    if (!item || item.kind === 'reminder') throw new Error('This pending message is no longer available.');
    return deliver(s, item);
  });
}
async function wake(s: Session) {
  if (!live(s) || s.running) return; clearTimeout(s.timer); s.running = true;
  try {
    const list = await entries(s);
    for (const item of list) {
      if (!live(s)) return;
      if (item.kind === 'draft' || item.nextAttempt > Date.now() || (item.failures ?? item.attempts) >= 5) continue;
      if (item.kind === 'reminder') {
        window.dispatchEvent(new CustomEvent('tavern:reminder', { detail: structuredClone(item) }));
        await save(s, { ...item, attempts: 5, failures: 5, error: 'Reminder due. Open the message or dismiss this reminder.' }); continue;
      }
      if (!navigator.onLine) continue;
      await deliver(s, item);
    }
  } finally {
    s.running = false;
    if (live(s)) {
      const pending = (await entries(s)).filter(item => item.kind !== 'draft' && (item.failures ?? item.attempts) < 5 && (navigator.onLine || item.kind === 'reminder'));
      if (pending.length) s.timer = setTimeout(() => void wake(s).catch(() => {}), Math.max(1000, Math.min(2147483647, Math.min(...pending.map(item => item.nextAttempt)) - Date.now())));
      notify();
    }
  }
}
export async function initializeOutbox(client: MatrixClient, send: Sender, options: Options = {}) {
  const actor = client.getUserId(), device = client.getDeviceId(), homeserver = server(client);
  if (!actor || !device) throw new Error('Your encrypted outbox needs a current Matrix account and device.');
  if(options.current&&!options.current())throw new Error('This outbox initializer belongs to an earlier account.');
  resetOutbox(); const current = generation;
  const owned = () => current === generation && client.getUserId() === actor && client.getDeviceId() === device && server(client) === homeserver && (options.current?.() ?? true);
  const store = await OutboxStore.open(actor, device, homeserver, owned);
  if (!owned()) { store.close(); return; }
  const s: Session = { client, actor, device, homeserver, store, send, options, generation: current, running: false, stop: () => {} }; active = s;
  const online = () => void wake(s).catch(() => {}), visible = () => { if (!document.hidden) online(); };
  window.addEventListener('online', online); document.addEventListener('visibilitychange', visible);
  s.stop = () => { window.removeEventListener('online', online); document.removeEventListener('visibilitychange', visible); };
  notify(); await wake(s);
}
export function resetOutbox() {
  generation++;
  if (active) { const old = active; active = null; clearTimeout(old.timer); old.stop(); old.store.close(); }
  notify();
}
