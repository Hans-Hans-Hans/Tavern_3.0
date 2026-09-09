export type ImagePreview = { blob: Blob; width: number; height: number; sourceWidth: number; sourceHeight: number };
export async function createImagePreview(file: File, signal?: AbortSignal): Promise<ImagePreview | null> {
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type) || file.size > 10 * 1024 * 1024 || !globalThis.createImageBitmap) return null;
  signal?.throwIfAborted(); let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file); signal?.throwIfAborted();
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) return null;
    const scale = Math.min(1, 480 / bitmap.width, 320 / bitmap.height), width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) return null; context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', .78)); signal?.throwIfAborted();
    return blob && blob.size <= 512 * 1024 ? { blob, width, height, sourceWidth: bitmap.width, sourceHeight: bitmap.height } : null;
  } catch (error) { if (signal?.aborted) throw error; return null; } finally { bitmap?.close(); }
}
