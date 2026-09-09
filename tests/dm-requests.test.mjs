import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
import { dmRequestsFixture } from './fixtures/dm-requests.mjs';
import { matrixThreadReader } from './fixtures/matrix-thread-reader.mjs';

function setup() {
  const f = dmRequestsFixture(), matrix = matrixThreadReader(f.client);
  const model = loadTs('../lib/dm-requests.ts', { './matrix': matrix, './api': { accountArtworkOwner: () => f.account }, './interactions': { blockUser: (...args) => f.blockUser(...args) }, './conversation-routing': loadTs('../lib/conversation-routing.ts', {}) });
  return { f, matrix, model, request: () => model.dmRequests().find(row => row.roomId === f.room.roomId) };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const joins = f => f.calls.filter(call => call.path.startsWith('/join/'));
const writes = f => f.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/account_data/m.direct'));

test('inbox uses actual self invitation state, excluding Spaces/private discussions and reading no messages or media', () => {
  const { f, model } = setup(); f.add('!space:local', { type: 'm.space' }); f.add('!private:local', { type: 'io.tavern.private_thread' }); f.add('!ordinary:local', { direct: false }); f.add('!self:local', { sender: f.actor }); f.add('!plain:local', { plain: true, public: true });
  const rows = model.dmRequests(); assert.deepEqual(rows.map(row => row.roomId).sort(), ['!plain:local', '!request:local']);
  assert.equal(rows.find(row => row.roomId === '!plain:local').encrypted, false); assert.equal(rows.find(row => row.roomId === '!plain:local').publicRoom, true); assert.equal(f.calls.length, 0);
});
test('accept joins natively and merges recipient m.direct with authoritative mappings from other devices', async () => {
  const { f, model, request } = setup(); f.mapping['@other-device:local'] = ['!new-on-other-device:local']; f.mapping['@alice:local'] = ['!another:local'];
  const result = await model.acceptDmRequest(request()); assert.equal(result.status, 'accepted'); assert.equal(f.room.getMyMembership(), 'join'); assert.equal(joins(f).length, 1);
  assert.deepEqual(f.mapping, { '@existing:local': ['!existing:local'], '@other-device:local': ['!new-on-other-device:local'], '@alice:local': ['!another:local', '!request:local'] }); assert.equal(model.dmRequests().length, 0);
});
test('native rejection retains invitation; mapping failure retains joined room and retries without a second join', async () => {
  const { f, model, request } = setup(); f.failJoin = true; await assert.rejects(model.acceptDmRequest(request()), /native invitation/); assert.equal(f.room.getMyMembership(), 'invite'); assert.equal(writes(f).length, 0);
  f.failJoin = false; f.failMap = true; const partial = await model.acceptDmRequest(request()); assert.equal(partial.status, 'partial'); assert.match(partial.message, /You joined/); assert.equal(request().joined, true);
  f.failMap = false; assert.equal((await model.acceptDmRequest(request())).status, 'accepted'); assert.equal(joins(f).length, 2); assert.equal(f.mapping['@alice:local'].length, 1);
});
test('join response before native sync produces a recoverable state instead of joining twice', async () => {
  const { f, model, request } = setup(); f.deferJoin = true;
  assert.equal((await model.acceptDmRequest(request())).status, 'partial'); assert.equal(request().joined, true); assert.equal((await model.acceptDmRequest(request())).status, 'partial'); assert.equal(joins(f).length, 1);
  f.member(f.room, 'join'); assert.equal((await model.acceptDmRequest(request())).status, 'accepted'); assert.equal(joins(f).length, 1);
});
test('a synced prior direct invitation can repair classification after an inbox module reload', async () => {
  const { f, matrix } = setup(); f.member(f.room, 'join');
  const model = loadTs('../lib/dm-requests.ts', { './matrix': matrix, './api': { accountArtworkOwner: () => f.account }, './interactions': { blockUser: f.blockUser }, './conversation-routing': loadTs('../lib/conversation-routing.ts', {}) });
  const request = model.dmRequests()[0]; assert.equal(request.joined, true); assert.equal((await model.acceptDmRequest(request)).status, 'accepted'); assert.equal(joins(f).length, 0);
});
test('withdrawn/replaced invitations and current ignores invalidate old action snapshots', async () => {
  const { f, model, request } = setup(), old = request(); f.member(f.room, 'leave'); await assert.rejects(model.acceptDmRequest(old), /changed or was withdrawn/);
  f.member(f.room, 'invite', '@mallory:local'); await assert.rejects(model.declineDmRequest(old), /changed or was withdrawn/);
  const newRequest = request(); f.accountData('m.ignored_user_list', { ignored_users: { '@mallory:local': {} } }); await assert.rejects(model.acceptDmRequest(newRequest), /blocked/); assert.equal(joins(f).length, 0);
});
test('account A to B to A during join does not write old classification or accept an old UI snapshot', async () => {
  const { f, model, request } = setup(), gate = deferred(), entered = deferred(), old = request();
  f.beforeJoin = async () => { entered.resolve(); await gate.promise; }; const work = model.acceptDmRequest(old); await entered.promise;
  f.account = {}; f.account = {}; gate.resolve(); await assert.rejects(work, /account changed/); assert.equal(writes(f).length, 0); await assert.rejects(model.acceptDmRequest(old), /account changed/);
});
test('account replacement or membership loss during a fresh account-data read cannot submit mappings', async () => {
  for (const replacement of ['account', 'membership']) {
    const { f, model, request } = setup(); f.beforeGet = async () => { if (replacement === 'account') f.account = {}; else f.member(f.room, 'leave'); };
    const work = model.acceptDmRequest(request()); if (replacement === 'account') await assert.rejects(work, /account changed/); else assert.equal((await work).status, 'partial'); assert.equal(writes(f).length, 0);
  }
});
test('serialized request actions cannot decline while acceptance is in progress', async () => {
  const { f, model, request } = setup(), gate = deferred(), entered = deferred(), row = request(); f.beforeJoin = async () => { entered.resolve(); await gate.promise; };
  const work = model.acceptDmRequest(row); await entered.promise; await assert.rejects(model.declineDmRequest(row), /already in progress/); gate.resolve(); assert.equal((await work).status, 'accepted');
});
test('block uses existing privacy operation and reports partial decline truthfully without undoing the block', async () => {
  const { f, model, request } = setup(); f.failLeave = true;
  const result = await model.blockDmRequest(request()); assert.equal(result.status, 'partial'); assert.match(result.message, /user is blocked/); assert.equal(request().blocked, true);
  await assert.rejects(model.acceptDmRequest(request()), /blocked/); f.failLeave = false; assert.equal((await model.declineDmRequest(request())).status, 'declined'); assert.equal(model.dmRequests().length, 0); assert.equal(joins(f).length, 0); assert.equal(f.calls.filter(call => call.method === 'BLOCK').length, 1);
});
test('block finishing after account replacement or a join never leaves that joined room', async () => {
  for (const replacement of ['account', 'membership']) {
    const { f, model, request } = setup(); f.beforeBlock = async () => { if (replacement === 'account') f.account = {}; else f.member(f.room, 'join'); };
    const work = model.blockDmRequest(request()); if (replacement === 'account') await assert.rejects(work, /account changed/); else assert.equal((await work).status, 'partial'); assert.equal(f.calls.some(call => call.path.endsWith('/leave')), false);
  }
});
test('a later native unblock is respected and a replacement invitation does not inherit a repair from another sender', async () => {
  const { f, model, request } = setup(); f.failLeave = true; await model.blockDmRequest(request()); assert.equal(request().blocked, true);
  f.accountData('m.ignored_user_list', { ignored_users: {} }); assert.equal(request().blocked, false);
  f.deferJoin = true; assert.equal((await model.acceptDmRequest(request())).status, 'partial');
  f.member(f.room, 'invite', '@new-sender:local'); assert.equal(request().joined, false); assert.equal(request().inviter, '@new-sender:local');
});
