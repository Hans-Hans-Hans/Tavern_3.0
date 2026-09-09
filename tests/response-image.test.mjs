import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { readImageResponse } = loadTs('../lib/response-image.ts', {});

function streamResponse(chunks, headers = {}) {
  const result = { reads: 0, cancelled: false };
  result.response = new Response(new ReadableStream({ pull(controller) { result.reads++; if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); }, cancel() { result.cancelled = true; } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'image/png', ...headers } });
  return result;
}

test('image bodies are capped before accumulating oversized chunked responses', async () => {
  const value = streamResponse([new Uint8Array(3), new Uint8Array(3), new Uint8Array(3)]);
  await assert.rejects(readImageResponse(value.response, 5, () => true), /too large/);
  assert.equal(value.reads, 2); assert.equal(value.cancelled, true); assert.equal(value.response.body.locked, false);
});

test('declared oversized and unsupported image responses cancel without reading content', async () => {
  for (const headers of [{ 'Content-Length': '5000' }, { 'Content-Type': 'text/html' }]) {
    const value = streamResponse([new Uint8Array(3)], headers);
    await assert.rejects(readImageResponse(value.response, 5, () => true));
    assert.equal(value.reads, 0); assert.equal(value.cancelled, true);
  }
});

test('body ownership changes and aborts cancel the active reader and release its lock', async () => {
  let owned = true, canceled = false;
  const changed = new Response(new ReadableStream({ pull(controller) { owned = false; controller.enqueue(new Uint8Array(2)); }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'image/png' } });
  await assert.rejects(readImageResponse(changed, 20, () => owned), /unavailable/); assert.equal(canceled, true); assert.equal(changed.body.locked, false);
  const controller = new AbortController(); let stopped = false;
  const hanging = new Response(new ReadableStream({ cancel() { stopped = true; } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'image/png' } });
  const pending = readImageResponse(hanging, 20, () => true, controller.signal); controller.abort();
  await assert.rejects(pending, /unavailable/); assert.equal(stopped, true); assert.equal(hanging.body.locked, false);
});

test('valid images preserve MIME and complete within the byte budget', async () => {
  const value = streamResponse([new Uint8Array([1, 2]), new Uint8Array([3])], { 'Content-Type': 'image/webp; charset=binary' });
  const blob = await readImageResponse(value.response, 3, () => true);
  assert.equal(blob.size, 3); assert.equal(blob.type, 'image/webp'); assert.equal(value.response.body.locked, false);
});
