import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { resolveJoinedEvent } = loadTs('../lib/resolve-event.ts', {});
const event = (roomId = '!target:local', id = '$message', encrypted = false) => ({ getId: () => id, getRoomId: () => roomId, isEncrypted: () => encrypted });
function fixture() {
  const f = { owned: true, membership: 'join', reads: 0, local: undefined, response: { event_id: '$message', room_id: '!target:local' } };
  f.room = { getMyMembership: () => f.membership, findEventById: () => f.local };
  f.client = { getRoom: () => f.room, fetchRoomEvent: async () => { f.reads++; return f.response; }, getEventMapper: () => raw => event(raw.room_id, raw.event_id), decryptEventIfNeeded: async () => {} };
  f.resolve = cached => resolveJoinedEvent(f.client, '!target:local', '$message', cached, () => f.owned);
  return f;
}
test('cross-room cached events are not relabeled and require a native scoped lookup', async () => {
  const f = fixture(), foreign = event('!private:local');
  f.local = foreign;
  const result = await f.resolve(foreign); assert.equal(f.reads, 1); assert.notEqual(result.event, foreign); assert.equal(result.event.getRoomId(), '!target:local');
  const valid = fixture(), cached = event(); assert.equal((await valid.resolve(cached)).event, cached); assert.equal(valid.reads, 0);
});
test('wrong native event identities and rooms fail before mapping or decryption', async () => {
  for (const response of [{ event_id: '$other', room_id: '!target:local' }, { event_id: '$message', room_id: '!private:local' }]) {
    const f = fixture(); f.response = response; f.client.getEventMapper = () => { throw new Error('Should not map a mismatched response'); };
    await assert.rejects(f.resolve(), /requested conversation/);
  }
  const scoped = fixture(); scoped.response = { event_id: '$message' }; assert.equal((await scoped.resolve()).event.getRoomId(), '!target:local');
});
test('account or membership changes during fetch/decryption cannot return a stale message', async () => {
  const f = fixture(); f.client.fetchRoomEvent = async () => { f.owned = false; return f.response; }; await assert.rejects(f.resolve(), /account changed/);
  const g = fixture(); g.client.decryptEventIfNeeded = async () => { g.owned = false; }; await assert.rejects(g.resolve(event('!target:local', '$message', true)), /account changed/);
  const h = fixture(); h.client.decryptEventIfNeeded = async () => { h.membership = 'leave'; }; await assert.rejects(h.resolve(event('!target:local', '$message', true)), /Join this conversation/);
});
