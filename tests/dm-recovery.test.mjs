import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const account = loadTs('../lib/dm-account-data.ts', {});
const model = loadTs('../lib/dm-recovery.ts', { './dm-account-data': account });
function setup() {
  const f = { active: true, writes: 0, native: { '@other:local': ['!kept:local'] }, hook: null };
  const event = (type, content, state_key = '') => ({ type, content, state_key });
  f.events = [event('m.room.create', {}), event('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }), event('m.room.join_rules', { join_rule: 'invite' }), event('m.room.member', { membership: 'join' }, '@me:local'), event('m.room.member', { membership: 'join' }, '@peer:local')];
  f.room = { getMyMembership: () => 'join', isSpaceRoom: () => false, hasEncryptionStateEvent: () => true, currentState: {
    getStateEvents: (type, key) => key === undefined ? f.events.filter(e => e.type === type).map(e => ({ getContent: () => e.content })) : (() => { const e = f.events.find(e => e.type === type && e.state_key === key); return e && { getContent: () => e.content }; })(),
  } };
  f.client = { getUserId: () => '@me:local', getRoom: () => f.room, roomState: async () => { await f.hook?.(); return f.events; }, http: { authedRequest: async () => f.native } };
  f.run = () => model.restoreDirectListing(f.client, '!restored:local', () => { if (!f.active) throw Error('retired'); }, async (update, check) => { check(); f.native = update(f.native); f.writes++; });
  return f;
}
test('explicit DM recovery merges native mapping without creating or changing the existing room', async () => {
  const f = setup(), original = structuredClone(f.events); await f.run();
  assert.equal(f.writes, 1); assert.deepEqual(f.native, { '@other:local': ['!kept:local'], '@peer:local': ['!restored:local'] }); assert.deepEqual(f.events, original);
  await f.run(); assert.deepEqual(f.native['@peer:local'], ['!restored:local']);
});
test('server channels, public rooms and private discussions cannot be silently classified as DMs', async () => {
  for (const change of [f => f.events.push({ type: 'm.space.parent', state_key: '!server:local', content: { via: ['local'] } }), f => f.events[0].content.type = 'io.tavern.private_thread', f => f.events[2].content.join_rule = 'public', f => f.events[1].content.algorithm = 'other']) {
    const f = setup(); f.hook = () => change(f); await assert.rejects(f.run()); assert.equal(f.writes, 0);
  }
});
test('session replacement and malformed native account data preserve the existing mapping', async () => {
  const f = setup(); f.hook = () => f.active = false; await assert.rejects(f.run(), /retired/); assert.equal(f.writes, 0);
  const g = setup(); g.native = null; await assert.rejects(g.run(), /invalid/); assert.equal(g.writes, 0);
});
