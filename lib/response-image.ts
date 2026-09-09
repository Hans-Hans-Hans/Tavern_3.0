const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Cap bytes while reading, including responses without trustworthy length headers. */
export async function readImageResponse(response: Response, maximumBytes: number, stillOwned: () => boolean, signal?: AbortSignal, allowedType = (type: string) => rasterTypes.has(type)): Promise<Blob> {
  const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  let reason = !response.ok || !stillOwned() || signal?.aborted || !allowedType(type) ? 'Image is unavailable.' : '';
  if (!reason && Number(response.headers.get('Content-Length') || 0) > maximumBytes) reason = 'Image is too large.';
  if (reason) { await response.body?.cancel().catch(() => {}); throw new Error(reason); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Image is unavailable.');
  const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (!stillOwned() || signal?.aborted) throw new Error('Image is unavailable.');
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error('Image is too large.');
      chunks.push(value);
    }
    if (!size) throw new Error('Image is unavailable.');
    return new Blob(chunks, { type });
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
