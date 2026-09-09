import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

function fixture() {
  const writes = [], members = { '@owner:test': { powerLevel: 100 }, '@mod:test': { powerLevel: 50 }, '@member:test': { powerLevel: 0 } };
  const room = { getMyMembership: () => 'join', getMember: id => members[id], currentState: { getStateEvents: (type, key) => key === undefined ? [] : null, maySendStateEvent: () => true, hasSufficientPowerLevelFor: (operation, value) => value >= 50 } };
  const client = { getRoom: () => room, getUserId: () => '@mod:test', getStateEvent: async () => ({ version: 1, icon: '🍻', accent: '#123456' }), sendStateEvent: async (...args) => writes.push(args) };
  const api = loadTs('../lib/channel-policy.ts', { './matrix': { getMatrixClient: () => client }, './roles': { readRolePolicy: () => null, effectiveRolePermissions: () => new Set(), memberRoleRank: () => 0 } });
  return { api, client, writes };
}
test('saving channel restrictions preserves existing icons and accents', async () => { const f = fixture(); await f.api.saveChannelPolicy('!room:test', { kind: 'announcement', slowModeSeconds: 30, archived: false }); assert.equal(f.writes[0][2].icon, '🍻'); assert.equal(f.writes[0][2].accent, '#123456'); assert.equal(f.writes[0][2].slowModeSeconds, 30); });
test('timeout UI excludes self and higher native authority', () => { const f = fixture(); assert.equal(f.api.canModerateMember('!room:test', '@mod:test', 'timeout'), false); assert.equal(f.api.canModerateMember('!room:test', '@owner:test', 'timeout'), false); assert.equal(f.api.canModerateMember('!room:test', '@member:test', 'timeout'), true); });
test('invalid timeout duration performs no Matrix mutation', async () => { const f = fixture(); await assert.rejects(f.api.timeoutMember('!room:test', '@member:test', 29 * 86400)); assert.equal(f.writes.length, 0); });
test('timeout writes are bound to the selected member and expiry', async () => { const f = fixture(); await f.api.timeoutMember('!room:test', '@member:test', 60, 'Cooling off'); assert.equal(f.writes[0][1], 'io.tavern.timeout'); assert.equal(f.writes[0][3], '@member:test'); assert.ok(f.writes[0][2].until > Date.now()); });
test('composer describes live temporary bans and fails closed on malformed expiry', () => {
  const f = fixture(), room = f.client.getRoom('!room:test'); room.roomId = '!room:test';
  let restriction = { version: 1, until: Date.now() + 3600000 };
  room.currentState.getStateEvents = (type, key) => key === undefined ? [] : type === 'io.tavern.tempban' ? { getContent: () => restriction } : null;
  assert.match(f.api.postingRestriction('!room:test'), /temporarily banned from this conversation/);
  restriction = { version: 1, until: 1 }; assert.equal(f.api.postingRestriction('!room:test'), '');
  restriction = {}; assert.match(f.api.postingRestriction('!room:test'), /Ask a moderator/);
});
test('composer inherits temporary bans only through reciprocal canonical server parents', () => {
  let reciprocal = true;
  const parentEvent = { getStateKey: () => '!server:test', getContent: () => ({ canonical: true, via: ['test'] }) };
  const room = { roomId: '!room:test', getMyMembership: () => 'join', currentState: { getStateEvents: (type, key) => key === undefined ? type === 'm.space.parent' ? [parentEvent] : [] : null } };
  const parent = { roomId: '!server:test', currentState: { getStateEvents: type => type === 'io.tavern.tempban' ? { getContent: () => ({ version: 1, until: Date.now() + 100000 }) } : type === 'm.space.child' && reciprocal ? { getContent: () => ({ via: ['test'] }) } : null } };
  const client = { getRoom: id => id === '!room:test' ? room : parent, getUserId: () => '@member:test' };
  const api = loadTs('../lib/channel-policy.ts', { './matrix': { getMatrixClient: () => client }, './roles': { readRolePolicy: id => id === '!server:test' ? {} : null, effectiveRolePermissions: () => new Set(), memberRoleRank: () => 0 } });
  assert.match(api.postingRestriction('!room:test'), /channel’s server/);
  reciprocal = false; assert.equal(api.postingRestriction('!room:test'), '');
});
