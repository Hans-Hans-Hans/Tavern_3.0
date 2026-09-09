import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
import { privateFixture } from './fixtures/private-thread.mjs';

function setup() { const f = privateFixture(); let client = f.client; const matrix = { getMatrixClient: () => client }; const roles = loadTs('../lib/roles.ts', { './matrix': matrix }); return { ...f, api: loadTs('../lib/private-threads.ts', { './member-state': loadTs('../lib/member-state.ts', {}), './matrix': matrix, './roles': roles }), switchClient: value => { client = value; }, fixture: f }; }

test('private creation keeps immutable source only in private room and never copies or indexes source content', async () => {
  const f = setup(); assert.equal(f.api.canCreatePrivateThread(f.sourceId), true);
  assert.equal(await f.api.createPrivateThread(f.sourceId, '  Private question  ', [f.other], '$opaque/root?#'), '!created:test');
  const [{ request }] = f.writes;
  assert.equal(request.visibility, 'private');
  assert.equal(request.creation_content['m.federate'], false);
  assert.deepEqual(request.creation_content['io.tavern.private_thread'], { version: 1, source_room_id: f.sourceId, source_event_id: '$opaque/root?#' });
  assert.equal(request.initial_state.find(e => e.type === 'm.room.history_visibility').content.history_visibility, 'joined');
  assert.equal(request.initial_state.find(e => e.type === 'io.tavern.private_thread.settings').content.title, 'Private question');
  assert.equal(request.initial_state.some(e => ['m.space.parent', 'm.space.child', 'm.room.message'].includes(e.type)), false);
  assert.equal(f.writes.length, 1);
});
test('creation revalidates current native source permission and each recipient before SDK call', async () => {
  const f = setup(); f.fixture.stateTransform = (events, id) => { if (id === f.sourceId) events.find(e => e.type === 'm.room.power_levels').content.events = { 'm.room.encrypted': 100 }; return events; };
  assert.equal(f.api.canCreatePrivateThread(f.sourceId), true);
  await assert.rejects(f.api.createPrivateThread(f.sourceId, 'Denied', [f.other]), /permissions/);
  f.fixture.stateTransform = (events, id) => { if (id === f.serverId) events.find(e => e.type === 'm.room.member' && e.state_key === f.other).content.membership = 'leave'; return events; };
  await assert.rejects(f.api.createPrivateThread(f.sourceId, 'Denied', [f.other]), /members changed/);
  assert.equal(f.writes.length, 0);
});
test('discovery includes only own joined or invited immutable bindings for selected source', () => {
  const f = setup(); f.seedPrivate('!invited:test', [f.author]);
  f.seedPrivate('!left:test'); f.states.get('!left:test').find(e => e.type === 'm.room.member' && e.state_key === f.author).content.membership = 'leave';
  f.seedPrivate('!fake:test'); f.states.get('!fake:test').find(e => e.type === 'm.room.create').content['m.federate'] = true;
  assert.deepEqual(f.api.privateThreadsForSource(f.sourceId).map(r => r.roomId).sort(), ['!invited:test', '!private:test']);
  assert.equal(f.api.privateThreadsForSource('!foreign:test').length, 0);
});
test('invitation gating and writes use both source native and custom authority', async () => {
  const f = setup(); assert.equal(f.api.canInvitePrivateThread(f.privateId), true);
  f.policy.overrides[f.sourceId] = { users: { [f.author]: { invite: -1 } } };
  assert.equal(f.api.canInvitePrivateThread(f.privateId), false);
  await assert.rejects(f.api.invitePrivateThreadMember(f.privateId, f.other), /permissions/);
  f.policy.overrides = {};
  await f.api.invitePrivateThreadMember(f.privateId, f.other);
  assert.equal(f.writes[0].action, 'invite');
  assert.equal(f.writes[0].roomId, f.privateId);
});
test('settings preserve draft on revision conflict and native source changes', async () => {
  const f = setup(), draft = f.api.readPrivateThreadSettings(f.client.getRoom(f.privateId)); draft.title = 'My draft';
  f.states.get(f.privateId).find(e => e.type === 'io.tavern.private_thread.settings').event_id = '$concurrent';
  await assert.rejects(f.api.savePrivateThreadSettings(f.privateId, draft), /changed elsewhere/);
  assert.equal(draft.title, 'My draft'); assert.equal(f.writes.length, 0);
  const fresh = await f.api.loadPrivateThreadSettings(f.privateId);
  await f.api.savePrivateThreadSettings(f.privateId, { ...fresh, archived: true });
  assert.equal(f.writes[0].content['io.tavern.previous_event'], '$concurrent');
  assert.equal(f.writes[0].content.archived, true);
});
test('member removal gating requires current source and private native plus custom hierarchy', async () => {
  const f = setup(); assert.equal(f.api.canModeratePrivateThreadMember(f.privateId, f.member), true);
  f.policy.members[f.member] = ['mod'];
  assert.equal(f.api.canModeratePrivateThreadMember(f.privateId, f.member), false);
  await assert.rejects(f.api.moderatePrivateThreadMember(f.privateId, f.member, 'kick'), /authority/);
  delete f.policy.members[f.member];
  await f.api.moderatePrivateThreadMember(f.privateId, f.member, 'kick');
  assert.equal(f.writes[0].action, 'kick');
});
test('private send uses SDK encryption target room, explicit mentions and blocks source departure or archive', async () => {
  const f = setup(); await f.api.sendPrivateThreadMessage(f.privateId, 'Hello ' + f.member, 'txn-1');
  assert.equal(f.writes[0].roomId, f.privateId); assert.deepEqual(f.writes[0].content['m.mentions'].user_ids, [f.member]);
  f.states.get(f.privateId).find(e => e.type === 'io.tavern.private_thread.settings').content.archived = true;
  await assert.rejects(f.api.sendPrivateThreadMessage(f.privateId, 'Denied', 'txn-2'), /archived/);
  f.states.get(f.sourceId).find(e => e.type === 'm.room.member' && e.state_key === f.author).content.membership = 'leave';
  assert.equal(f.api.canPostPrivateThread(f.privateId), false);
  await assert.rejects(f.api.sendPrivateThreadMessage(f.privateId, 'Denied', 'txn-3'), /membership/);
});
test('account switch while checking source prevents a private mutation', async () => {
  const f = setup(); f.fixture.stateTransform = events => { f.switchClient(null); return events; };
  await assert.rejects(f.api.createPrivateThread(f.sourceId, 'Denied', [f.other]), /session changed/);
  assert.equal(f.writes.length, 0);
});
test('fresh source bounds canonical parents before requesting additional room state', async () => {
  const f = setup(); let requested = 0;
  const original = f.client.roomState;
  f.client.roomState = async id => { requested++; return original(id); };
  for (let index = 0; index < 11; index++) f.states.get(f.sourceId).push(f.event('m.space.parent', '!parent' + index + ':test', { canonical: true, via: ['test'] }));
  await assert.rejects(f.api.createPrivateThread(f.sourceId, 'Denied', []), /policy is unavailable/);
  assert.equal(requested, 1);
});
test('private rich-message action gates follow source roles, native powers and archive state', () => {
  const f = setup(); f.policy.roles[0].permissions.push('add_reactions', 'pin_messages');
  assert.deepEqual(f.api.privateThreadMessagePermissions(f.privateId, f.author), { send: true, edit: true, delete: true, pin: true, react: true });
  f.policy.overrides[f.sourceId] = { users: { [f.author]: { add_reactions: -1, pin_messages: -1, send_messages: -1, manage_messages: -1 } } };
  assert.deepEqual(f.api.privateThreadMessagePermissions(f.privateId, f.member), { send: false, edit: false, delete: false, pin: false, react: false });
  assert.equal(f.api.privateThreadMessagePermissions(f.privateId, f.author).delete, true, 'Members retain authorized deletion of their own messages');
});
test('a room claiming private type without joined encryption privacy cannot start client key sharing', async () => {
  const f = setup(); f.states.get(f.privateId).find(e => e.type === 'm.room.history_visibility').content.history_visibility = 'shared';
  assert.equal(f.api.canPostPrivateThread(f.privateId), false);
  assert.equal(f.api.canInvitePrivateThread(f.privateId), false);
  await assert.rejects(f.api.sendPrivateThreadMessage(f.privateId, 'Denied', 'txn'), /encrypted private discussion/);
  await assert.rejects(f.api.invitePrivateThreadMember(f.privateId, f.other), /encrypted private discussion/);
  assert.equal(f.writes.length, 0);
});
