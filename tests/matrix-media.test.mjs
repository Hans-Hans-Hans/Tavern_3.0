import test from 'node:test';
import assert from 'node:assert/strict';
import { getHttpUriForMxc } from 'matrix-js-sdk/lib/content-repo.js';
import { loadTs } from './load-ts.mjs';

const { authenticatedMatrixMediaUrl: mediaUrl } = loadTs('../lib/matrix-media.ts', {});
const mxc = 'mxc://chat.example.test/Actual_Media-123';
function client(base) {
  return { getHomeserverUrl: () => base, mxcUrlToHttp: (...args) => getHttpUriForMxc(base, ...args) };
}

test('actual SDK media conversion retains the managed account gateway after normalization', () => {
  const c = client('https://chat.example.test/api/matrix');
  assert.equal(new URL(c.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true)).pathname, '/_matrix/client/v1/media/download/chat.example.test/Actual_Media-123');
  const url = new URL(mediaUrl(c, mxc));
  assert.equal(url.origin, 'https://chat.example.test');
  assert.equal(url.pathname, '/api/matrix/_matrix/client/v1/media/download/chat.example.test/Actual_Media-123');
  assert.equal(url.searchParams.has('access_token'), false);
});

test('profile thumbnails preserve gateway paths, dimensions and authenticated endpoint', () => {
  const url = new URL(mediaUrl(client('https://chat.example.test/api/matrix/'), mxc, { width: 128, height: 64 }));
  assert.equal(url.pathname, '/api/matrix/_matrix/client/v1/media/thumbnail/chat.example.test/Actual_Media-123');
  assert.equal(url.searchParams.get('width'), '128');
  assert.equal(url.searchParams.get('height'), '64');
  assert.equal(url.searchParams.get('method'), 'crop');
});

test('direct Matrix sessions and an SDK that preserves its base path remain supported', () => {
  const direct = client('https://matrix.example.test');
  assert.equal(new URL(mediaUrl(direct, mxc)).pathname, '/_matrix/client/v1/media/download/chat.example.test/Actual_Media-123');
  const gateway = client('https://chat.example.test/api/matrix');
  const normalized = mediaUrl(gateway, mxc);
  assert.equal(mediaUrl({ ...gateway, mxcUrlToHttp: () => normalized }, mxc), normalized);
});

test('invalid media and foreign or nonmedia destinations cannot receive account authorization', () => {
  const c = client('https://chat.example.test/api/matrix');
  for (const value of ['https://outside.example/file', 'mxc://chat.example.test/../../login', 'mxc://chat.example.test/id?access_token=secret', undefined]) {
    assert.throws(() => mediaUrl(c, value), /Invalid Matrix media/);
  }
  for (const value of ['https://outside.example/_matrix/client/v1/media/download/x/y', 'https://chat.example.test/api/auth/session', 'https://chat.example.test/_matrix/client/v1/media/download/x/y?access_token=secret']) {
    assert.throws(() => mediaUrl({ ...c, mxcUrlToHttp: () => value }, mxc), /Invalid Matrix media/);
  }
});
