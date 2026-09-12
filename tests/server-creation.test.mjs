import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as sdk from 'matrix-js-sdk';
import { loadTs } from './load-ts.mjs';

function fixture() {
  const f = { account: {}, writes: [], beforeConfig: null, beforeCreate: null };
  f.client = { getUserId: () => '@owner:test', getDeviceId: () => 'DEVICE', getHomeserverUrl: () => 'https://test', createRoom: async value => { f.writes.push(value); if (f.beforeCreate) await f.beforeCreate(); return { room_id: '!server:test' }; } };
  const matrix = { getMatrixClient: () => f.client };
  const templates = loadTs('../lib/server-templates.ts', {});
  const defaults = loadTs('../lib/server-defaults.ts', { './matrix': matrix, './channel-administration': {}, './notification-preferences': loadTs('../lib/notification-preferences.ts', { './matrix': matrix }), './roles': { rolesEvent: 'io.tavern.roles', defaultRolePolicy: owner => ({ version: 1, owner }) }, './server-templates': templates });
  const source = readFileSync(new URL('../lib/matrix.ts', import.meta.url), 'utf8') + '\nexport function fixtureClient(value:any,moduleSdk:any){client=value;sdk=moduleSdk;}';
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = {}, noop = new Proxy({}, { get: () => () => {} });
  const dependencies = { './api': { accountArtworkOwner: () => f.account }, './instance': { readInstanceConfig: async () => { if (f.beforeConfig) await f.beforeConfig(); return { serverRolePolicy: true }; } }, './server-defaults': defaults };
  new Function('require', 'exports', compiled)(name => dependencies[name] || noop, module);
  module.fixtureClient(f.client, sdk); f.module = module; f.templates = templates.serverTemplates; return f;
}

test('actual Matrix server creation is private and creates the reviewed categories and icon atomically', async () => {
  const f = fixture(), categories = f.templates.friends.categories;
  assert.deepEqual(await f.module.matrixApi('createServer', { name: ' My community ', categories, icon: 'mxc://test/art' }), { id: '!server:test' });
  const request = f.writes[0]; assert.equal(request.name, 'My community');
  assert.equal(request.visibility, sdk.Visibility.Private); assert.equal(request.preset, sdk.Preset.PrivateChat);
  assert.deepEqual(request.creation_content, { type: 'm.space', 'm.federate': false });
  assert.deepEqual(request.initial_state.find(event => event.type === 'io.tavern.server.layout').content, { version: 1, categories, channels: [] });
  assert.deepEqual(request.initial_state.find(event => event.type === 'm.room.avatar').content, { url: 'mxc://test/art' });
  assert.equal(request.initial_state.find(event => event.type === 'io.tavern.roles').content.owner, '@owner:test');
  assert.equal(request.power_level_content_override, undefined);
});

test('configuration await cannot create a server with an obsolete account or device', async () => {
  for (const change of [f => { f.account = {}; }, f => { f.module.fixtureClient({ ...f.client }, sdk); }, f => { f.client.getDeviceId = () => 'OTHER'; }]) {
    const f = fixture(); f.beforeConfig = () => change(f);
    await assert.rejects(f.module.matrixApi('createServer', { name: 'Draft' }), /account changed/);
    assert.equal(f.writes.length, 0);
  }
});

test('invalid initial categories cannot leave an orphan server and late replies are account fenced', async () => {
  const f = fixture();
  await assert.rejects(f.module.matrixApi('createServer', { name: 'Draft', categories: [{ id: 'wrong/path', name: 'Category', icon: '' }] }), /category/);
  assert.equal(f.writes.length, 0);
  f.beforeCreate = () => { f.account = {}; };
  await assert.rejects(f.module.matrixApi('createServer', { name: 'Draft' }), /account changed/);
  assert.equal(f.writes.length, 1);
});
