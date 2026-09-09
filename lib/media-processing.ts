export type ImagePreview = { blob: Blob; width: number; height: number; sourceWidth: number; sourceHeight: number; duration?: number };
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

/** Decode only a bounded local file; poster bytes are encrypted with the attachment. */
export async function createVideoPreview(file: File, signal?: AbortSignal): Promise<ImagePreview | null> {
  if (!/^video\/(mp4|webm|ogg)$/.test(file.type) || file.size > 10 * 1024 * 1024 || !file.size) return null;
  signal?.throwIfAborted();
  const video = document.createElement('video'), source = URL.createObjectURL(file);
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); video.removeEventListener('loadedmetadata', metadata); video.removeEventListener('loadeddata', ready); video.removeEventListener('error', failed); signal?.removeEventListener('abort', aborted); };
      const done = (error?: Error) => { cleanup(); error ? reject(error) : resolve(); };
      const metadata = () => { if (!video.videoWidth || !video.videoHeight || video.videoWidth * video.videoHeight > 40_000_000) done(new Error('Video dimensions exceed the preview limit.')); };
      const ready = () => { if (video.videoWidth && video.videoHeight && video.videoWidth * video.videoHeight <= 40_000_000) done(); else done(new Error('Video preview is unavailable.')); };
      const failed = () => done(new Error('This browser cannot decode this video.'));
      const aborted = () => done(new Error('Video preview cancelled.'));
      const timer = setTimeout(failed, 5000);
      video.addEventListener('loadedmetadata', metadata); video.addEventListener('loadeddata', ready); video.addEventListener('error', failed); signal?.addEventListener('abort', aborted, { once: true });
      video.src = source; video.load();
    });
    signal?.throwIfAborted();
    const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight, scale = Math.min(1, 480 / sourceWidth, 320 / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) return null; context.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', .78)); signal?.throwIfAborted();
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : undefined;
    return blob && blob.size <= 512 * 1024 ? { blob, width, height, sourceWidth, sourceHeight, duration } : null;
  } catch (error) { if (signal?.aborted) throw error; return null; }
  finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(source); }
}

export function createMediaPreview(file: File, signal?: AbortSignal) { return file.type.startsWith('video/') ? createVideoPreview(file, signal) : createImagePreview(file, signal); }
