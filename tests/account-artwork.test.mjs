import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

test('account artwork uses device-bound gateway auth without starting a Matrix SDK session', async t => {
  const api = loadTs('../lib/api.ts', { './image-cache': loadTs('../lib/image-cache.ts', {}), './response-image': loadTs('../lib/response-image.ts', {}) }); api.setAccountDevice('A');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }); return url.endsWith('/upload') ? Response.json({ content_uri: 'mxc://local/avatar' }) : new Response('image-pixels', { headers: { 'Content-Type': 'image/png' } }); });
  assert.equal(await api.uploadAccountArtwork(new Blob(['optimized-pixels'], { type: 'image/webp' })), 'mxc://local/avatar');
  const path = '/api/matrix/_matrix/client/v1/media/thumbnail/local/avatar?width=96&height=96';
  assert.equal((await api.fetchAccountArtwork(path, new AbortController().signal)).type, 'image/png');
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    assert.ok(url.startsWith('/api/matrix/_matrix/')); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers.Authorization, 'Bearer cookie-session:A'); assert.equal(options.headers['X-Tavern-Device'], 'A');
    assert.ok(!url.includes('token='));
  }
  await assert.rejects(api.fetchAccountArtwork('https://outside.test/image', new AbortController().signal));
  assert.equal(requests.length, 2);
});

test('artwork rejects account-switch responses and caps streamed thumbnail bytes', async t => {
  const api = loadTs('../lib/api.ts', { './image-cache': loadTs('../lib/image-cache.ts', {}), './response-image': loadTs('../lib/response-image.ts', {}) }); api.setAccountDevice('A'); const first = api.accountArtworkOwner();
  t.mock.method(globalThis, 'fetch', async () => { api.setAccountDevice('B'); return Response.json({ content_uri: 'mxc://local/avatar' }); });
  await assert.rejects(api.uploadAccountArtwork(new Blob(['pixels'], { type: 'image/png' })), /account changed/);
  assert.notEqual(api.accountArtworkOwner(), first);
  const path = '/api/matrix/_matrix/client/v1/media/thumbnail/local/avatar';
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } }));
  await assert.rejects(api.fetchAccountArtwork(path, new AbortController().signal), /too large/);
  t.mock.method(globalThis, 'fetch', async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }));
  await assert.rejects(api.fetchAccountArtwork(path, new AbortController().signal), /unavailable/);
});

test('device rotation disposes unused artwork and rejects A to B to A responses before reading their bodies', async t => {
  const cache = loadTs('../lib/image-cache.ts', {}), api = loadTs('../lib/api.ts', { './image-cache': cache, './response-image': loadTs('../lib/response-image.ts', {}) });
  api.setAccountDevice('A'); const owner = api.accountArtworkOwner(), revoked = [];
  const revoke = URL.revokeObjectURL.bind(URL); t.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); revoke(url); });
  const lease = cache.acquireCachedImage(owner, 'avatar', async () => new Blob(['image']), () => api.accountArtworkOwner() === owner);
  const url = await lease.promise; lease.release();
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    api.setAccountDevice('B'); api.setAccountDevice('A');
    return new Response(new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'image/png' } });
  });
  await assert.rejects(api.uploadAccountArtwork(new Blob(['image'], { type: 'image/png' })), /account changed/);
  assert.deepEqual(revoked, [url]); assert.equal(cancelled, 1);
  await assert.rejects(api.fetchAccountArtwork('/api/matrix/_matrix/client/v1/media/thumbnail/local/avatar', new AbortController().signal), /unavailable/);
  assert.equal(cancelled, 2);
});

test('rejected thumbnail responses are canceled without buffering error content', async t => {
  const api = loadTs('../lib/api.ts', { './image-cache': loadTs('../lib/image-cache.ts', {}), './response-image': loadTs('../lib/response-image.ts', {}) }); api.setAccountDevice('A');
  let cancelled = false, reads = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { status: 403, headers: { 'Content-Type': 'image/png' } }));
  await assert.rejects(api.fetchAccountArtwork('/api/matrix/_matrix/client/v1/media/thumbnail/local/avatar', new AbortController().signal), /unavailable/);
  assert.equal(reads, 0); assert.equal(cancelled, true);
});
