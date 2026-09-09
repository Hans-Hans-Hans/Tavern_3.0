import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const palette = loadTs('../lib/palette-search.ts', {});
const { captureSearchInventory, searchInventoryLimits } = loadTs('../lib/unified-search.ts', { './palette-search': palette });

function fixture() {
  const f = { actor: '@me:test', device: 'DEVICE', owner: {}, ignored: [], rooms: [] };
  f.room = (id, name, members = [], space = false, membership = 'join') => ({ roomId: id, name, membership, members,
    getMyMembership() { return this.membership; }, isSpaceRoom: () => space,
    getJoinedMembers() { return this.members.filter(member => member.membership === 'join'); },
    getMember(id) { return this.members.find(member => member.userId === id); } });
  f.client = { getUserId: () => f.actor, getDeviceId: () => f.device, getIgnoredUsers: () => f.ignored, getRooms: () => f.rooms, getRoom: id => f.rooms.find(room => room.roomId === id) };
  f.capture = ids => { const owner = f.owner; return captureSearchInventory(f.client, () => f.owner === owner, ids); };
  return f;
}
const member = (userId, name, membership = 'join') => ({ userId, name, membership });

test('one bounded inventory separates current joined servers, conversations and cached shared people', () => {
  const f = fixture(); f.rooms = [f.room('!one:test', 'Project channel', [member('@a:test', 'Alice'), member('@old:test', 'Old', 'leave')]),
    f.room('!server:test', 'Project server', [member('@a:test', 'Captain Alice'), member('@me:test', 'Me')], true),
    f.room('!invite:test', 'Secret project', [member('@hidden:test', 'Hidden')], false, 'invite')];
  const inventory = f.capture();
  assert.deepEqual(inventory.search('project', 'all').items.map(item => item.kind).sort(), ['channel', 'server']);
  const person = inventory.search('captain', 'people').items[0];
  assert.equal(person.userId, '@a:test'); assert.equal(person.roomId, '!one:test'); inventory.assertResult(person);
  assert.equal(inventory.search('hidden', 'people').items.length, 0);
  assert.equal(inventory.search('from:alice', 'all').items.length, 0);
  assert.equal(f.capture(['!one:test']).search('', 'servers').items.length, 0);
});

test('pagination is bounded and does not re-fetch members or native room history', () => {
  const f = fixture(); f.rooms = Array.from({ length: 43 }, (_, i) => f.room('!r' + i + ':test', 'Project ' + i));
  const inventory = f.capture(), first = inventory.search('project', 'channels'), second = inventory.search('project', 'channels', first.nextOffset), last = inventory.search('project', 'channels', second.nextOffset);
  assert.deepEqual([first.items.length, second.items.length, last.items.length], [20, 20, 3]);
  assert.equal(new Set([...first.items, ...second.items, ...last.items].map(item => item.id)).size, 43);
  assert.equal(last.nextOffset, null); assert.throws(() => inventory.search('', 'all', -1));
});

test('limits report partial cached membership without inventing a directory', () => {
  const f = fixture(); f.rooms = [f.room('!large:test', 'Large', Array.from({ length: searchInventoryLimits.members + 1 }, (_, i) => member('@u' + i + ':test', 'User ' + i)))];
  const inventory = f.capture(); assert.equal(inventory.truncated, true);
  assert.equal(inventory.search('@u5000:test', 'people').items.length, 0);
  assert.ok(inventory.search('@u4999:test', 'people').items.length > 0);
});

test('leave, member departure, ignore and model replacement invalidate navigation', () => {
  for (const change of ['leave', 'member', 'ignore', 'replacement']) {
    const f = fixture(), room = f.room('!r:test', 'Room', [member('@a:test', 'Alice')]); f.rooms = [room];
    const inventory = f.capture(), person = inventory.search('alice', 'people').items[0];
    if (change === 'leave') room.membership = 'leave';
    else if (change === 'member') room.members[0].membership = 'leave';
    else if (change === 'ignore') f.ignored.push('@a:test');
    else f.rooms[0] = { ...room };
    assert.throws(() => inventory.assertResult(person)); assert.equal(inventory.search('alice', 'people').items.length, 0);
  }
});

test('same-client actor/device and API generation replacement reject old results including A to B to A', () => {
  for (const change of ['actor', 'device', 'owner']) {
    const f = fixture(); f.rooms = [f.room('!r:test', 'Room')]; const inventory = f.capture();
    if (change === 'actor') f.actor = '@other:test'; else if (change === 'device') f.device = 'OTHER'; else { f.owner = {}; f.owner = {}; }
    assert.throws(() => inventory.search('', 'all')); assert.throws(() => inventory.assertRoom('!r:test'));
  }
});
