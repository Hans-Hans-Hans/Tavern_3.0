import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
test('avatars share one authenticated fetch and isolate caches between account sessions', async () => {
  let client = {}, calls = 0;
  const { acquireProfileImage } = loadTs('../lib/profile-image-cache.ts', { './matrix': { getMatrixClient: () => client }, './community': { profileImageBlob: async () => { calls++; return new Blob(['image'], { type: 'image/png' }); } } });
  const first = acquireProfileImage('mxc://local/avatar', 80), second = acquireProfileImage('mxc://local/avatar', 80);
  assert.equal(await first.promise, await second.promise); assert.equal(calls, 1); first.release(); first.release();
  const third = acquireProfileImage('mxc://local/avatar', 80); assert.equal(await third.promise, await second.promise); assert.equal(calls, 1);
  client = {}; second.release(); third.release();
  const differentSession = acquireProfileImage('mxc://local/avatar', 80); assert.notEqual(await differentSession.promise, await first.promise); assert.equal(calls, 2); client = null; differentSession.release();
});
test('unused avatar cache evicts old images and refetches within its memory bound', async () => {
  let client = {}, calls = 0;
  const { acquireProfileImage } = loadTs('../lib/profile-image-cache.ts', { './matrix': { getMatrixClient: () => client }, './community': { profileImageBlob: async () => { calls++; return new Blob(['image'], { type: 'image/png' }); } } });
  for (let i = 0; i < 130; i++) { const lease = acquireProfileImage('mxc://local/' + i, 80); await lease.promise; lease.release(); }
  const old = acquireProfileImage('mxc://local/0', 80); await old.promise; assert.equal(calls, 131); client = null; old.release();
});
