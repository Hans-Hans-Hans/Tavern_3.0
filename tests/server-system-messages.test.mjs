import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
import { systemMessagesFixture } from './fixtures/server-system-messages.mjs';

function setup() {
  const f = systemMessagesFixture(), matrix = { getMatrixClient: () => f.client };
  const roles = loadTs('../lib/roles.ts', { './api': { accountArtworkOwner: () => 0 }, './conference-publication': loadTs('../lib/conference-publication.ts', {}), './matrix': matrix });
  const administration = loadTs('../lib/channel-administration.ts', { './matrix': matrix, './roles': roles });
  f.api = loadTs('../lib/server-system-messages.ts', { './matrix': matrix, './channel-administration': administration, './api': { accountArtworkOwner: () => f.accountOwner, isManagedAccount: () => f.managed, requestApi: (...args) => f.request(...args) } });
  f.draft = { ...f.api.emptySystemMessageSettings(), enabled: true, channelId: f.channel.roomId, hookId: 'notices', leaves: true };
  return f;
}

test('system notice contracts distinguish unconfigured and off, reject unsafe destinations and invalid delivery summaries', () => {
  const f = setup(); assert.equal(f.api.parseServerSystemMessages(f.data).settings, null);
  assert.deepEqual(f.api.parseServerSystemMessages({ ...f.data, ready: false, destinations: [] }).counts, { pending: 2, sent: 3, cancelled: 1 });
  for (const change of [{ ready: undefined }, { eventId: '$unexpected' }, { counts: { pending: -1 } }, { counts: { delivered: 12 } }, { destinations: [...f.data.destinations, ...f.data.destinations] }, { destinations: [{ hookId: 'unsafe/id', roomId: f.channel.roomId, name: 'Wrong' }] }]) assert.throws(() => f.api.parseServerSystemMessages({ ...f.data, ...change }), /incomplete/);
  for (const change of [{ joins: false, leaves: false }, { enabled: 1 }, { channelId: '!with space' }, { 'io.tavern.previous_event': '$' }, { unknown: true }]) assert.equal(f.api.parseSystemMessageSettings({ ...f.draft, ...change }), null);
});

test('only current native plus custom server managers can load, and identity loss after an API wait discards the response', async () => {
  for (const reason of ['custom', 'native', 'membership', 'managed', 'device', 'account']) {
    const f = setup();
    if (reason === 'custom') f.actor = '@member:local';
    if (reason === 'native') f.server.put('m.room.power_levels', { users: {}, state_default: 50 });
    if (reason === 'membership') f.server.membership = 'leave';
    if (reason === 'managed') f.managed = false;
    if (reason === 'device' || reason === 'account') f.beforeRequest = async () => { if (reason === 'device') f.accountOwner = {}; else f.client = { ...f.client }; };
    await assert.rejects(f.api.loadServerSystemMessages(f.server.roomId), /authority changed/);
    assert.equal(f.requests.length, ['device', 'account'].includes(reason) ? 1 : 0);
  }
});

test('saving confirms exact server scope and uses the current native CAS after refreshing hook configuration', async () => {
  const f = setup(), initial = await f.api.loadServerSystemMessages(f.server.roomId);
  await assert.rejects(f.api.saveServerSystemMessages(f.server.roomId, f.draft, initial, 'Server'), /exact server ID/);
  const result = await f.api.saveServerSystemMessages(f.server.roomId, f.draft, initial, f.server.roomId);
  assert.deepEqual(f.requests.at(-1), { path: '/servers/!server%3Alocal/system-messages', method: 'PUT', body: { confirmation: f.server.roomId, settings: f.draft } });
  assert.equal(result.eventId, f.data.eventId); assert.equal(result.settings.enabled, true);
  const disabled = { ...f.draft, enabled: false, channelId: '', hookId: '' };
  await f.api.saveServerSystemMessages(f.server.roomId, disabled, result, f.server.roomId);
  assert.equal(f.requests.at(-1).body.settings['io.tavern.previous_event'], result.eventId);
});

test('a changed native route or hook configuration preserves the caller draft and prevents PUT', async () => {
  for (const change of ['route', 'hooks', 'destination', 'ready', 'account']) {
    const f = setup(), initial = await f.api.loadServerSystemMessages(f.server.roomId), draft = structuredClone(f.draft);
    f.beforeRequest = async () => {
      if (change === 'route') { f.data.eventId = '$other'; f.data.settings = { ...f.draft }; }
      if (change === 'hooks') f.data.configurationRevision = 'configuration-2';
      if (change === 'destination') f.data.destinations = [];
      if (change === 'ready') f.data.ready = false;
      if (change === 'account') f.accountOwner = {};
    };
    await assert.rejects(f.api.saveServerSystemMessages(f.server.roomId, draft, initial, f.server.roomId));
    assert.ok(f.requests.every(request => request.method === 'GET')); assert.deepEqual(draft, f.draft);
  }
});

test('existing routes can be disabled with the bot unavailable without creating hooks or changing membership', async () => {
  const f = setup(); f.data.settings = { ...f.draft }; f.data.eventId = '$existing'; f.data.enabled = false; f.data.ready = false; f.data.destinations = []; f.data.configurationRevision = '';
  const loaded = await f.api.loadServerSystemMessages(f.server.roomId);
  await assert.rejects(f.api.saveServerSystemMessages(f.server.roomId, f.draft, loaded, f.server.roomId), /Provision/);
  await f.api.saveServerSystemMessages(f.server.roomId, { ...f.draft, enabled: false }, loaded, f.server.roomId);
  assert.equal(f.requests.at(-1).body.settings.enabled, false); assert.deepEqual(f.writes, []);
});

test('opaque room IDs are encoded as one route segment and unconfirmed saves require explicit reload', async () => {
  const f = setup(), room = f.room('!server/opaque?query#fragment:local', 'm.space');
  const loaded = await f.api.loadServerSystemMessages(room.roomId); assert.equal(f.requests[0].path, '/servers/!server%2Fopaque%3Fquery%23fragment%3Alocal/system-messages');
  const original = f.request; f.request = async (...args) => args[2] === 'PUT' ? {} : original(...args);
  await assert.rejects(f.api.saveServerSystemMessages(room.roomId, { ...f.draft, enabled: false }, loaded, room.roomId), /did not confirm/);
});
