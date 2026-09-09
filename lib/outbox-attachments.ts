/** Encrypted local attachment snapshots. This is separate from Matrix E2EE:
 * the persisted media descriptor contains the key needed by a future message.
 * No filenames, descriptor keys, or original file bytes are stored in clear. */
export const outboxFileLimit = 10 * 1024 * 1024;
export const outboxByteLimit = 100 * 1024 * 1024;
export const outboxAttachmentLimit = 5;
export type UploadedAttachment = { id: string; roomId: string; name: string; size: number; type: string; url: string; file: Record<string, any> | null; info: Record<string, any> };
export type QueuedAttachment = {
  id: string; name: string; size: number; type: string;
  descriptor?: UploadedAttachment;
  transactionId: string;
  eventId?: string;
};
export type EncryptedFileRecord = { id: string; itemId: string; size: number; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };
const encoder = new TextEncoder(), decoder = new TextDecoder();
const plain = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const mxc = (value: unknown): value is string => typeof value === 'string' && value.length <= 2048 && /^mxc:\/\/[^/\s?#\\]+\/[^/\s?#\\]+$/.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
export function validateQueuedAttachments(items: unknown, roomId: string): asserts items is QueuedAttachment[] {
  if (!Array.isArray(items) || items.length > outboxAttachmentLimit) throw new Error('Keep up to five attachments in one queued message.');
  const ids = new Set(), transactions = new Set();
  for (const item of items) {
    if (!plain(item) || !identifier(item.id) || ids.has(item.id) || !identifier(item.transactionId) || transactions.has(item.transactionId)
      || typeof item.name !== 'string' || !item.name.length || item.name.length > 1024 || /[\u0000-\u001f\u007f]/.test(item.name)
      || typeof item.type !== 'string' || item.type.length > 255 || /[\u0000-\u001f\u007f]/.test(item.type)
      || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > outboxFileLimit
      || item.eventId !== undefined && (typeof item.eventId !== 'string' || !item.eventId.startsWith('$') || item.eventId.length > 1024)) throw new Error('The queued attachment metadata is invalid. Keep the original file and reattach it.');
    ids.add(item.id); transactions.add(item.transactionId);
    if (item.descriptor !== undefined) {
      const descriptor = item.descriptor;
      if (!plain(descriptor) || descriptor.id !== item.id || descriptor.roomId !== roomId || descriptor.name !== item.name || descriptor.type !== item.type || descriptor.size !== item.size
        || !mxc(descriptor.url) || !plain(descriptor.info) || ![null, undefined].includes(descriptor.file) && (!plain(descriptor.file) || descriptor.file.url !== descriptor.url
          || descriptor.file.v !== 'v2' || !plain(descriptor.file.key) || descriptor.file.key.kty !== 'oct' || descriptor.file.key.alg !== 'A256CTR'
          || typeof descriptor.file.key.k !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(descriptor.file.key.k)
          || typeof descriptor.file.iv !== 'string' || !/^[A-Za-z0-9+/]{22}={0,2}$/.test(descriptor.file.iv)
          || !plain(descriptor.file.hashes) || typeof descriptor.file.hashes.sha256 !== 'string' || !/^[A-Za-z0-9+/]{43}=?$/.test(descriptor.file.hashes.sha256))) throw new Error('The saved uploaded attachment does not match this conversation or file.');
      if (encoder.encode(JSON.stringify(descriptor)).byteLength > 32768) throw new Error('The saved uploaded attachment metadata is too large.');
    }
    if (item.eventId && !item.descriptor) throw new Error('An acknowledged attachment must retain its original uploaded descriptor.');
  }
}
export function attachmentTransaction(nonce: string, index: number) {
  if (!identifier(nonce) || nonce.length > 220 || !Number.isInteger(index) || index < 0 || index >= outboxAttachmentLimit) throw new Error('The attachment transaction is invalid.');
  return nonce + '-f' + index;
}
export function acknowledgeAttachment(items: QueuedAttachment[], id: string, transactionId: string, eventId: string): QueuedAttachment[] {
  if (typeof eventId !== 'string' || !eventId.startsWith('$') || eventId.length > 1024) throw new Error('The homeserver did not confirm this attachment. Its transaction is kept for retry.');
  const item = items.find(value => value.id === id);
  if (!item || item.transactionId !== transactionId || !item.descriptor || item.eventId && item.eventId !== eventId) throw new Error('The attachment acknowledgement does not match the pending delivery.');
  return items.map(value => value.id === id ? { ...value, eventId } : value);
}
const aad = (owner: string, itemId: string, id: string) => encoder.encode(JSON.stringify(['tavern-outbox-file', 1, owner, itemId, id]));
export async function sealOutboxFile(key: CryptoKey, owner: string, itemId: string, attachment: QueuedAttachment, file: File, current: () => boolean): Promise<EncryptedFileRecord> {
  if (!current()) throw new Error('Your account changed.');
  if (file.size !== attachment.size || file.name !== attachment.name || file.type !== attachment.type || file.size > outboxFileLimit || !file.size) throw new Error('The original file does not match this queued attachment.');
  const bytes = await file.arrayBuffer();
  if (!current()) throw new Error('Your account changed.');
  const iv = crypto.getRandomValues(new Uint8Array(12)), ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(owner, itemId, attachment.id) }, key, bytes);
  if (!current()) throw new Error('Your account changed.');
  return { id: attachment.id, itemId, size: file.size, iv, ciphertext };
}
export async function openOutboxFile(key: CryptoKey, owner: string, itemId: string, attachment: QueuedAttachment, record: EncryptedFileRecord, current: () => boolean): Promise<File> {
  if (!current()) throw new Error('Your account changed.');
  if (record.id !== attachment.id || record.itemId !== itemId || record.size !== attachment.size || record.ciphertext.byteLength !== attachment.size + 16) throw new Error('The saved file is incomplete or belongs to another pending message.');
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: aad(owner, itemId, attachment.id) }, key, record.ciphertext);
  if (!current()) throw new Error('Your account changed.');
  return new File([bytes], attachment.name, { type: attachment.type });
}
