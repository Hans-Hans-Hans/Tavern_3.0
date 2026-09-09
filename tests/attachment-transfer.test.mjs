import test from 'node:test';
import assert from 'node:assert/strict';
import * as encryption from 'matrix-encrypt-attachment';
import { loadTs } from './load-ts.mjs';
const client = { getAccessToken: () => 'cookie-session:fixture' }, attachment = { url: 'mxc://local/file', type: 'video/webm' };
function transfer(crypto = encryption) { return loadTs('../lib/attachment-transfer.ts', { './matrix-media': { authenticatedMatrixMediaUrl: () => 'https://local/api/matrix/_matrix/client/v1/media/download/local/file' }, 'matrix-encrypt-attachment': crypto }).readMatrixAttachment; }
function stream(chunks, status = 200, headers = {}) {
  const result = { reads: 0, cancelled: false };
  result.response = new Response(new ReadableStream({ pull(controller) { result.reads++; if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); }, cancel() { result.cancelled = true; } }, { highWaterMark: 0 }), { status, headers });
  return result;
}
test('real encrypted attachment round trip retains the authenticated gateway and safe MIME', async t => {
  const original = new TextEncoder().encode('private video bytes'), encrypted = await encryption.encryptAttachment(original.buffer);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /\/api\/matrix\/_matrix\/client\/v1\/media\/download/); assert.equal(options.headers.Authorization, 'Bearer cookie-session:fixture'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
    assert.notDeepEqual(new Uint8Array(encrypted.data), original); return new Response(encrypted.data);
  });
  const blob = await transfer()(client, { ...attachment, file: encrypted.info }, 100, () => true);
  assert.equal(blob.type, 'video/webm'); assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), original);
  encrypted.info.hashes.sha256 = 'broken'; await assert.rejects(transfer()(client, { ...attachment, file: encrypted.info }, 100, () => true));
});
test('rejected and oversized responses cancel before reading untrusted bodies', async t => {
  for (const value of [stream([new Uint8Array(4)], 401), stream([new Uint8Array(4)], 200, { 'Content-Length': '999' })]) {
    t.mock.method(globalThis, 'fetch', async () => value.response);
    await assert.rejects(transfer()(client, attachment, 5, () => true)); assert.equal(value.reads, 0); assert.equal(value.cancelled, true);
  }
});
test('chunked responses enforce the cap while reading and release the reader', async t => {
  const value = stream([new Uint8Array(3), new Uint8Array(3), new Uint8Array(3)]); t.mock.method(globalThis, 'fetch', async () => value.response);
  await assert.rejects(transfer()(client, attachment, 5, () => true), /too large/); assert.equal(value.reads, 2); assert.equal(value.cancelled, true); assert.equal(value.response.body.locked, false);
});
test('account changes before response and after decryption cannot return attachment bytes', async t => {
  let owned = true; const value = stream([new Uint8Array(2)]);
  t.mock.method(globalThis, 'fetch', async () => { owned = false; return value.response; });
  await assert.rejects(transfer()(client, attachment, 5, () => owned), /account changed/); assert.equal(value.cancelled, true); assert.equal(value.reads, 0);
  owned = true; t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(2)));
  await assert.rejects(transfer({ decryptAttachment: async bytes => { owned = false; return bytes; } })(client, { ...attachment, file: {} }, 5, () => owned), /account changed/);
});
test('abort interrupts a blocked attachment reader and revokes its lease', async t => {
  let cancelled = false, start; const started = new Promise(resolve => { start = resolve; });
  const response = new Response(new ReadableStream({ pull() { start(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  t.mock.method(globalThis, 'fetch', async () => response);
  const controller = new AbortController(), pending = transfer()(client, attachment, 5, () => true, controller.signal);
  await started; controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled, true); assert.equal(response.body.locked, false);
});
