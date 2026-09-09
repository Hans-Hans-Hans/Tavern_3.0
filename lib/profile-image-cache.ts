import { getMatrixClient } from './matrix';
import { profileImageBlob } from './community';
type Entry = { promise: Promise<string>; references: number; url: string; bytes: number; touched: number; controller: AbortController };
const caches = new WeakMap<object, Map<string, Entry>>();
const maximumEntries = 128, maximumBytes = 24 * 1024 * 1024;
function trim(cache: Map<string, Entry>, discardAllUnused = false) { let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0); for (const [key, entry] of [...cache.entries()].sort((a, b) => a[1].touched - b[1].touched)) { if (!discardAllUnused && cache.size <= maximumEntries && bytes <= maximumBytes) break; if (entry.references > 0) continue; cache.delete(key); entry.controller.abort(); if (entry.url) URL.revokeObjectURL(entry.url); bytes -= entry.bytes; } }
/** One authenticated fetch per image/size/session; released entries have bounded memory. */
export function acquireProfileImage(mxc: string, size: number, height = size) {
  const client = getMatrixClient(); if (!client) return { promise: Promise.reject<string>(new Error('Sign in to load profiles.')), release: () => {} };
  let cache = caches.get(client); if (!cache) { cache = new Map(); caches.set(client, cache); }
  const key = `${size}x${height}:${mxc}`, existing = cache.get(key); let entry: Entry;
  if (existing) { entry = existing; entry.references++; entry.touched = Date.now(); }
  else {
    const controller = new AbortController(); entry = { promise: Promise.resolve(''), references: 1, url: '', bytes: 0, touched: Date.now(), controller };
    const targetCache = cache; entry.promise = profileImageBlob(mxc, size, controller.signal, height).then(blob => { if (controller.signal.aborted) throw new Error('Profile image request cancelled.'); entry.bytes = blob.size; entry.url = URL.createObjectURL(blob); trim(targetCache); return entry.url; }).catch(error => { if (targetCache.get(key) === entry) targetCache.delete(key); throw error; }); cache.set(key, entry); trim(cache);
  }
  let released = false; const targetCache = cache;
  return { promise: entry.promise, release: () => { if (released) return; released = true; entry.references = Math.max(0, entry.references - 1); entry.touched = Date.now(); if (!entry.references && !entry.url) { entry.controller.abort(); targetCache.delete(key); } trim(targetCache, getMatrixClient() !== client); } };
}
