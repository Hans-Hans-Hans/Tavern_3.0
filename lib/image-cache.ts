type Entry = { promise: Promise<string>; references: number; url: string; bytes: number; touched: number; controller: AbortController };
const caches = new WeakMap<object, Map<string, Entry>>();
const disposedOwners = new WeakSet<object>();
const maximumEntries = 128, maximumBytes = 24 * 1024 * 1024;
function discard(entry: Entry) { entry.controller.abort(); if (entry.url) URL.revokeObjectURL(entry.url); entry.url = ''; entry.bytes = 0; }
/** Object URLs outlive JavaScript GC, so session owners must dispose explicitly. */
export function disposeCachedImageOwner(owner: object) {
  disposedOwners.add(owner);
  const cache = caches.get(owner); if (!cache) return;
  caches.delete(owner);
  for (const entry of cache.values()) discard(entry);
  cache.clear();
}
function trim(cache: Map<string, Entry>, discardAllUnused = false) {
  let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [key, entry] of [...cache.entries()].sort((a, b) => a[1].touched - b[1].touched)) {
    if (!discardAllUnused && cache.size <= maximumEntries && bytes <= maximumBytes) break;
    if (entry.references > 0) continue;
    cache.delete(key); bytes -= entry.bytes; discard(entry);
  }
}
/** Share authenticated artwork only within the owning account/session. */
export function acquireCachedImage(owner: object, key: string, fetchImage: (signal: AbortSignal) => Promise<Blob>, stillOwned: () => boolean) {
  if (disposedOwners.has(owner) || !stillOwned()) { disposeCachedImageOwner(owner); return { promise: Promise.reject<string>(new Error('Image request cancelled.')), release: () => {} }; }
  let cache = caches.get(owner); if (!cache) { cache = new Map(); caches.set(owner, cache); }
  const existing = cache.get(key); let entry: Entry;
  if (existing) { entry = existing; entry.references++; entry.touched = Date.now(); }
  else {
    const controller = new AbortController(); entry = { promise: Promise.resolve(''), references: 1, url: '', bytes: 0, touched: Date.now(), controller };
    const targetCache = cache;
    entry.promise = fetchImage(controller.signal).then(blob => {
      if (controller.signal.aborted || disposedOwners.has(owner) || !stillOwned()) throw new Error('Image request cancelled.');
      entry.bytes = blob.size; entry.url = URL.createObjectURL(blob); trim(targetCache); return entry.url;
    }).catch(error => { if (targetCache.get(key) === entry) targetCache.delete(key); throw error; });
    cache.set(key, entry); trim(cache);
  }
  let released = false; const targetCache = cache;
  const promise = entry.promise.then(url => {
    if (released || entry.controller.signal.aborted || disposedOwners.has(owner) || !stillOwned()) throw new Error('Image request cancelled.');
    return url;
  });
  return { promise, release: () => {
    if (released) return; released = true; entry.references = Math.max(0, entry.references - 1); entry.touched = Date.now();
    if (!entry.references && !entry.url) { entry.controller.abort(); if (targetCache.get(key) === entry) targetCache.delete(key); }
    if (!stillOwned()) disposeCachedImageOwner(owner); else trim(targetCache);
  } };
}
