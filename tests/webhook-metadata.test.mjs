import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { webhookMetadata, webhookAvatarUrl } = loadTs('../lib/webhook-metadata.ts', {});

test('webhook content remains an untrusted bounded label without changing author identity', () => {
  const raw = { id: 'builds', name: 'Build alerts', avatar_url: 'mxc://media.test/id_123', verified: true, sender: '@administrator:test' };
  assert.deepEqual(webhookMetadata(raw), { id: 'builds', name: 'Build alerts', avatar: raw.avatar_url });
  for (const value of [null, {}, { ...raw, id: '../escape' }, { ...raw, name: 'x'.repeat(81) }, { ...raw, name: 'spoof\nadmin' }]) assert.equal(webhookMetadata(value), null);
  assert.equal(webhookMetadata({ ...raw, avatar_url: 'https://tracking.test/avatar' }).avatar, '');
});

test('webhook avatars use authenticated same-origin Matrix thumbnails and reject remote URLs', () => {
  assert.equal(webhookAvatarUrl('mxc://media.test/id_123'), '/api/matrix/_matrix/client/v1/media/thumbnail/media.test/id_123?width=96&height=96&method=crop');
  for (const value of ['https://tracking.test/pixel', 'data:image/svg+xml,<svg/>', 'mxc://host/id?token=secret', 'mxc://host/a/b', 'mxc://host/../../admin', 'mxc://host/' + 'a'.repeat(2048)]) assert.equal(webhookAvatarUrl(value), '');
});
