import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const imageCache = loadTs('../lib/image-cache.ts', {});
test('avatars share one authenticated fetch and isolate caches between account sessions', async () => {
  let client = {}, calls = 0;
  const { acquireProfileImage } = loadTs('../lib/profile-image-cache.ts', { './image-cache': imageCache, './matrix': { getMatrixClient: () => client }, './community': { profileImageBlob: async () => { calls++; return new Blob(['image'], { type: 'image/png' }); } } });
  const first = acquireProfileImage('mxc://local/avatar', 80), second = acquireProfileImage('mxc://local/avatar', 80);
  assert.equal(await first.promise, await second.promise); assert.equal(calls, 1); first.release(); first.release();
  const third = acquireProfileImage('mxc://local/avatar', 80); assert.equal(await third.promise, await second.promise); assert.equal(calls, 1);
  client = {}; second.release(); third.release();
  const differentSession = acquireProfileImage('mxc://local/avatar', 80); assert.notEqual(await differentSession.promise, await first.promise); assert.equal(calls, 2); client = null; differentSession.release();
});
test('unused avatar cache evicts old images and refetches within its memory bound', async () => {
  let client = {}, calls = 0;
  const { acquireProfileImage } = loadTs('../lib/profile-image-cache.ts', { './image-cache': imageCache, './matrix': { getMatrixClient: () => client }, './community': { profileImageBlob: async () => { calls++; return new Blob(['image'], { type: 'image/png' }); } } });
  for (let i = 0; i < 130; i++) { const lease = acquireProfileImage('mxc://local/' + i, 80); await lease.promise; lease.release(); }
  const old = acquireProfileImage('mxc://local/0', 80); await old.promise; assert.equal(calls, 131); client = null; old.release();
});

test('a released stale image request cannot delete a newer in-flight entry for the same image', async () => {
  const { acquireCachedImage } = loadTs('../lib/image-cache.ts', {}); const owner = {}; let calls = 0, rejectFirst;
  const fetcher = () => { calls++; return calls === 1 ? new Promise((_, reject) => { rejectFirst = reject; }) : Promise.resolve(new Blob(['image'], { type: 'image/png' })); };
  const first = acquireCachedImage(owner, 'avatar', fetcher, () => true); const failed = assert.rejects(first.promise);
  first.release(); const second = acquireCachedImage(owner, 'avatar', fetcher, () => true);
  rejectFirst(new Error('Cancelled previous request')); await failed; const third = acquireCachedImage(owner, 'avatar', fetcher, () => true);
  assert.equal(await second.promise, await third.promise); assert.equal(calls, 2); second.release(); third.release();
});

test('disposing a session revokes already-unused object URLs and rejects stale or queued cache hits', async t => {
  const cache = loadTs('../lib/image-cache.ts', {}), owner = {}, revoked = [];
  const revoke = URL.revokeObjectURL.bind(URL); t.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); revoke(url); });
  const first = cache.acquireCachedImage(owner, 'avatar', async () => new Blob(['image']), () => true);
  const url = await first.promise; first.release();
  const queued = cache.acquireCachedImage(owner, 'avatar', async () => { throw new Error('Should reuse'); }, () => true);
  cache.disposeCachedImageOwner(owner);
  await assert.rejects(queued.promise, /cancelled/); queued.release();
  await assert.rejects(cache.acquireCachedImage(owner, 'avatar', async () => { throw new Error('Must not fetch'); }, () => true).promise, /cancelled/);
  cache.disposeCachedImageOwner(owner);
  assert.deepEqual(revoked, [url]);
});

test('owner disposal cancels an active request and prevents a late download from creating a blob URL', async t => {
  const cache = loadTs('../lib/image-cache.ts', {}), owner = {}; let resolve, signal, created = 0;
  const create = URL.createObjectURL.bind(URL); t.mock.method(URL, 'createObjectURL', blob => { created++; return create(blob); });
  const lease = cache.acquireCachedImage(owner, 'pending', async abort => { signal = abort; return new Promise(done => { resolve = done; }); }, () => true);
  const failed = assert.rejects(lease.promise, /cancelled/);
  cache.disposeCachedImageOwner(owner); assert.equal(signal.aborted, true); resolve(new Blob(['late']));
  await failed; lease.release(); assert.equal(created, 0);
});

test('an invalid owner cannot receive an existing resolved cache URL even before explicit cleanup', async () => {
  const cache = loadTs('../lib/image-cache.ts', {}), owner = {}; let owned = true;
  const lease = cache.acquireCachedImage(owner, 'avatar', async () => new Blob(['image']), () => owned);
  await lease.promise; lease.release(); owned = false;
  await assert.rejects(cache.acquireCachedImage(owner, 'avatar', async () => new Blob(['bad']), () => owned).promise, /cancelled/);
});
