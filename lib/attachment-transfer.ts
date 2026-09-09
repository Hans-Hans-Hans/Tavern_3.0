import type { MatrixClient } from 'matrix-js-sdk';
import { authenticatedMatrixMediaUrl } from './matrix-media';

export async function readMatrixAttachment(client: MatrixClient, attachment: { url: string; type?: string; file?: any }, maximumBytes: number, stillOwned: () => boolean, signal?: AbortSignal): Promise<Blob> {
  const checkOwner = () => { signal?.throwIfAborted(); if (!stillOwned()) throw new Error('Your account changed. Reopen this attachment.'); };
  checkOwner();
  const response = await fetch(authenticatedMatrixMediaUrl(client, attachment.url), { headers: { Authorization: 'Bearer ' + client.getAccessToken() }, credentials: 'same-origin', referrerPolicy: 'no-referrer', cache: 'no-store', signal });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => { void reader?.cancel().catch(() => {}); };
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    checkOwner();
    if (!response.ok) throw new Error('Could not download this attachment.');
    if (Number(response.headers.get('Content-Length')) > maximumBytes) throw new Error('This attachment is too large to preview safely.');
    reader = response.body?.getReader(); if (!reader) throw new Error('This browser cannot stream attachments.');
    signal?.addEventListener('abort', abort, { once: true });
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const next = await reader.read(); checkOwner(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) throw new Error('This attachment is too large to preview safely.');
      chunks.push(next.value);
    }
    bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  } finally {
    signal?.removeEventListener('abort', abort);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else await response.body?.cancel().catch(() => {});
  }
  checkOwner(); let payload = bytes.buffer;
  if (attachment.file) { const { decryptAttachment } = await import('matrix-encrypt-attachment'); payload = await decryptAttachment(payload, attachment.file); }
  checkOwner();
  if (payload.byteLength > maximumBytes) throw new Error('This attachment is too large to preview safely.');
  const mime = typeof attachment.type === 'string' && /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|ogg)|audio\/(mpeg|mp4|ogg|webm|wav|flac))$/.test(attachment.type) ? attachment.type : 'application/octet-stream';
  return new Blob([payload], { type: mime });
}
