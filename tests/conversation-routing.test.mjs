import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { isPrivateDiscussion } = loadTs('../lib/conversation-routing.ts', {});
const room = value => ({ currentState: { getStateEvents: (type, key) => type === 'm.room.create' && key === '' ? { getContent: () => value } : null } });
test('private room type routes separately even when its source binding is missing or invalid', () => {
  assert.equal(isPrivateDiscussion(room({ type: 'io.tavern.private_thread' })), true);
  assert.equal(isPrivateDiscussion(room({ type: 'io.tavern.private_thread', 'io.tavern.private_thread': { source_room_id: 'bad' } })), true);
  for (const value of [null, room({}), room({ type: 'm.space' }), room({ type: 'other', 'io.tavern.private_thread': true })]) assert.equal(isPrivateDiscussion(value), false);
});
