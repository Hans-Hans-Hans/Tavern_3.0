import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemNoticeMessages } from '../scripts/smoke-system-messages.mjs';

test('native bot history excludes its membership join while retaining every encrypted or plaintext message', () => {
  const sender = '@cisystembot:chat.example.test';
  const encrypted = { event_id: '$notice', sender, type: 'm.room.encrypted', content: { ciphertext: 'ciphertext' } };
  const plaintext = { event_id: '$unexpected-plaintext', sender, type: 'm.room.message', content: { msgtype: 'm.notice', body: 'Must still fail the delivery assertion' } };
  const joined = { event_id: '$bot-join', sender, type: 'm.room.member', state_key: sender, content: { membership: 'join' } };
  const other = { ...encrypted, event_id: '$other', sender: '@cialice:chat.example.test' };
  assert.deepEqual(systemNoticeMessages([encrypted, joined]), [encrypted]);
  assert.deepEqual(systemNoticeMessages([plaintext, encrypted, joined, other]), [plaintext, encrypted]);
  assert.deepEqual(systemNoticeMessages([joined]), []);
  assert.throws(() => systemNoticeMessages({ chunk: [] }));
  assert.throws(() => systemNoticeMessages(Array(101).fill(encrypted)));
});
