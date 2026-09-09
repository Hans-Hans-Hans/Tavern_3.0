import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
test('call navigation rechecks shared membership and rejects invalid actions and self messaging', () => {
  const room = { getMyMembership: () => 'join', getMember: () => ({ membership: 'join' }) };
  const client = { getRoom: () => room, getUserId: () => '@me:local' };
  const { participantNavigationAllowed: allowed } = loadTs('../lib/participant-navigation.ts', { './matrix': { getMatrixClient: () => client } });
  const value = { action: 'profile', roomId: '!room:local', userId: '@peer:local' };
  assert.equal(allowed(value), true); assert.equal(allowed({ ...value, action: 'message' }), true);
  assert.equal(allowed({ ...value, action: 'message', userId: '@me:local' }), false);
  assert.equal(allowed({ ...value, roomId: 'https://external.test' }), false); assert.equal(allowed({ ...value, action: 'ban' }), false);
  room.getMember = () => ({ membership: 'leave' }); assert.equal(allowed(value), false);
  room.getMember = () => ({ membership: 'join' }); room.getMyMembership = () => 'leave'; assert.equal(allowed(value), false);
});
