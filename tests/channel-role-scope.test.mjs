import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { loadTs } from './load-ts.mjs';
const actor = '@owner:local', server = '!server:local', channel = '!voice:local', rolesEvent = 'io.tavern.roles';
function setup() {
  const f = { account: {}, current: true, writes: [], requests: [], before: null };
  const ev = (type, content, state_key = '', room_id = server) => ({ type, state_key, content, event_id: '$' + type + '-' + state_key, room_id, sender: actor });
  const client = createClient({ baseUrl: 'https://role-scope.local', userId: actor, deviceId: 'DEVICE', accessToken: 'fixture-only', fetchFn: async (url, options) => {
    const path = decodeURIComponent(new URL(url).pathname); f.requests.push([options.method, path]);
    const id = path.includes(channel) ? channel : server;
    let result = path.endsWith('/state') ? structuredClone(f.states[id]) : structuredClone(f.policy);
    await f.before?.(path, options.method);
    if (options.method === 'PUT') { f.writes.push({ path, value: JSON.parse(options.body) }); result = { event_id: '$saved' }; }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  f.client = client;
  const model = loadTs('../lib/roles.ts', { './matrix': { getMatrixClient: () => f.client }, './api': { accountArtworkOwner: () => f.account }, './conference-publication': loadTs('../lib/conference-publication.ts', {}) });
  f.policy = model.defaultRolePolicy(actor);
  f.policy.callPublicationVersion = 1;
  f.policy.roles.push({ id: 'gamer', name: 'Gamer', position: 10, color: '', icon: '', permissions: [], mentionable: false, separate: false });
  f.policy.members['@gamer:local'] = ['gamer'];
  f.policy.overrides['!other:local'] = { roles: { everyone: { send_messages: -1 } }, users: {} };
  f.states = {
    [server]: [ev('m.room.create', { type: 'm.space', room_version: '12', 'm.federate': false }), ev('m.room.member', { membership: 'join' }, actor), ev('m.room.power_levels', { users: {} }), ev('m.space.child', { via: ['local'] }, channel), ev(rolesEvent, f.policy)],
    [channel]: [ev('m.room.create', { room_version: '12', 'm.federate': false }, '', channel), ev('m.room.member', { membership: 'join' }, actor, channel), ev('m.space.parent', { canonical: true, via: ['local'] }, server, channel)],
  };
  for (const id of [server, channel]) {
    const room = new Room(id, client, actor); room.updateMyMembership('join'); room.currentState.setStateEvents(f.states[id].map(event => new MatrixEvent(structuredClone(event)))); client.store.storeRoom(room);
  }
  const current = () => { if (!f.current) throw Error('Retired channel view'); };
  return { f, model, current };
}

test('actual SDK channel scope and role write preserve native paths, revision and unrelated role state', async () => {
  const { f, model, current } = setup();
  await model.checkChannelRoleScope(server, channel, current);
  const before = model.readRolePolicy(server), next = structuredClone(before);
  next.overrides[channel] = { roles: { gamer: { join_calls: 1 } }, users: {} };
  await model.saveRolePolicy(server, next, before, current, channel);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].path, '/_matrix/client/v3/rooms/' + server + '/state/' + rolesEvent + '/');
  assert.equal(f.writes[0].value['io.tavern.previous_event'], '$io.tavern.roles-');
  assert.deepEqual(f.writes[0].value.overrides['!other:local'], before.overrides['!other:local']);
  assert.deepEqual(f.writes[0].value.roles, before.roles); assert.deepEqual(f.writes[0].value.members, before.members);
  assert.equal(model.effectiveRolePermissions(f.writes[0].value, '@gamer:local', channel).has('join_calls'), true);
});

test('actual native scope reads deny departed membership, detached links and malformed state before role writes', async () => {
  for (const change of [
    f => { f.states[channel].find(e => e.type === 'm.room.member').content.membership = 'leave'; },
    f => { f.states[channel].find(e => e.type === 'm.space.parent').content = {}; },
    f => { f.states[server].find(e => e.type === 'm.space.child').content = {}; },
    f => { f.states[channel].push(structuredClone(f.states[channel][0])); },
    f => { f.states[channel][0].room_id = '!foreign:local'; },
  ]) {
    const { f, model, current } = setup(); change(f);
    await assert.rejects(model.checkChannelRoleScope(server, channel, current)); assert.equal(f.writes.length, 0);
  }
});

test('a retired view during actual SDK role reads cannot submit the old channel draft', async () => {
  const { f, model, current } = setup();
  const before = model.readRolePolicy(server), next = structuredClone(before); next.overrides[channel] = { roles: { everyone: { join_calls: -1 } }, users: {} };
  f.before = (path) => { if (path.endsWith('/state')) f.current = false; };
  await assert.rejects(model.saveRolePolicy(server, next, before, current, channel), /Retired channel view/);
  assert.equal(f.writes.length, 0);
});

test('channel/account A to B to A retirement during actual SDK relationship read stops further work', async () => {
  const { f, model, current } = setup();
  f.before = () => { f.account = {}; };
  await assert.rejects(model.checkChannelRoleScope(server, channel, current), /account/);
  assert.equal(f.requests.length, 1); assert.equal(f.writes.length, 0);
});

test('a newly observed native parent detach or role change is not discarded by the final writer', async () => {
  for (const changed of ['link', 'roles']) {
    const { f, model, current } = setup();
    await model.checkChannelRoleScope(server, channel, current);
    const before = model.readRolePolicy(server), next = structuredClone(before);
    next.overrides[channel] = { roles: { gamer: { join_calls: 1 } }, users: {} };
    let observed = false;
    f.before = path => {
      if (!observed && path.endsWith('/state/' + rolesEvent + '/')) {
        observed = true;
        if (changed === 'link') f.states[server].find(e => e.type === 'm.space.child').content = {};
        else f.states[server].find(e => e.type === rolesEvent).content = { ...f.policy, members: { '@changed:local': ['gamer'] } };
      }
    };
    await assert.rejects(model.saveRolePolicy(server, next, before, current, channel));
    assert.equal(observed, true); assert.equal(f.writes.length, 0);
  }
});

test('category Member deny then channel role allow restricts voice without changing same-scope deny precedence', () => {
  const { model } = setup(), policy = model.defaultRolePolicy(actor), user = '@gamer:local', other = '@ordinary:local';
  policy.roles.push({ id: 'gamer', name: 'Gamer', position: 10, permissions: [] }); policy.members[user] = ['gamer'];
  policy.categoryOverrides.games = { roles: { everyone: { join_calls: -1 } }, users: {} };
  policy.overrides[channel] = { roles: { gamer: { join_calls: 1 } }, users: {} };
  assert.equal(model.effectiveRolePermissions(policy, user, channel, 'games').has('join_calls'), true);
  assert.equal(model.effectiveRolePermissions(policy, other, channel, 'games').has('join_calls'), false);
  assert.equal(model.effectiveRolePermissions(policy, user, '!other:local', 'games').has('join_calls'), false);
  assert.equal(model.effectiveRolePermissions(policy, other, '!outside:local').has('join_calls'), true);
  policy.overrides[channel].roles.everyone = { join_calls: -1 };
  assert.equal(model.effectiveRolePermissions(policy, user, channel, 'games').has('join_calls'), false);
});
