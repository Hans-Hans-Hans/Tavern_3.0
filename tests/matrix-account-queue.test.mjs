import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as sdk from 'matrix-js-sdk';
import { loadTs } from './load-ts.mjs';
import { dmRequestsFixture } from './fixtures/dm-requests.mjs';

const saved = 'io.harbor.bookmarks';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup() {
  const api = loadTs('../lib/api.ts', { './image-cache': { disposeCachedImageOwner() {} }, './response-image': {}, './web-push': { startWebPushSession() {}, stopWebPushSession() {} } }); api.setAccountDevice('A');
  const source = readFileSync(new URL('../lib/matrix.ts', import.meta.url), 'utf8') + '\nexport function fixtureClient(value:any,moduleSdk:any){client=value;sdk=moduleSdk;}\nexport function fixtureCache(event:any){eventCache.set(event.getId(),event);}';
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = {}, noop = new Proxy({}, { get: () => () => {} });
  const dependencies = { './api': api, './instance': { readInstanceConfig: async () => ({ serverRolePolicy: false }) } };
  new Function('require', 'exports', 'sessionStorage', compiled)(name => dependencies[name] || noop, module, { removeItem() {} });
  const attach = f => {
    f.member(f.room, 'join'); module.fixtureClient(f.client, sdk);
    for (const id of ['$first', '$second', '$new']) module.fixtureCache(new sdk.MatrixEvent({ event_id: id, room_id: f.room.roomId, type: 'm.room.message', sender: f.actor, content: { body: id, msgtype: 'm.text' } }));
  };
  const f = dmRequestsFixture(); attach(f); return { f, module, api, attach };
}
const bookmarkWrites = f => f.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/account_data/' + saved));

test('actual bookmark operations serialize against latest account data, preserve toggles and recover after a failed write', async () => {
  const { f, module } = setup(), gate = deferred(), entered = deferred(), send = f.client.setAccountData.bind(f.client); let first = true;
  f.client.setAccountData = async (...args) => { if (first) { first = false; entered.resolve(); await gate.promise; } return send(...args); };
  const one = module.matrixApi('save', { id: '$first' }); await entered.promise; const two = module.matrixApi('save', { id: '$second' });
  assert.equal(bookmarkWrites(f).length, 0); gate.resolve(); await Promise.all([one, two]);
  assert.deepEqual(f.client.getAccountData(saved).getContent().events.map(event => event.id), ['$first', '$second']);
  await module.matrixApi('save', { id: '$first' }); assert.deepEqual(f.client.getAccountData(saved).getContent().events.map(event => event.id), ['$second']);
  f.client.setAccountData = async () => { throw new Error('Native write failed'); }; await assert.rejects(module.matrixApi('save', { id: '$new' }), /Native write failed/);
  f.client.setAccountData = send; await module.matrixApi('save', { id: '$first' }); assert.deepEqual(f.client.getAccountData(saved).getContent().events.map(event => event.id), ['$second', '$first']);
});
test('clearing Matrix while an old bookmark task is queued never retargets it to the replacement client', async () => {
  const { f, module, attach } = setup(), gate = deferred(), entered = deferred(), send = f.client.setAccountData.bind(f.client);
  f.client.setAccountData = async (...args) => { entered.resolve(); await gate.promise; return send(...args); };
  const one = module.matrixApi('save', { id: '$first' }); await entered.promise; const two = module.matrixApi('save', { id: '$second' }); const old = Promise.allSettled([one, two]);
  module.clearLocalMatrixSession(); const replacement = dmRequestsFixture(); attach(replacement);
  // clearLocalMatrixSession clears the queue map, but already chained promises
  // still exist. New account work must proceed independently of those promises.
  await module.matrixApi('save', { id: '$new' }); gate.resolve();
  const results = await old; assert.ok(results.every(result => result.status === 'rejected' && /account changed/.test(result.reason.message)));
  assert.equal(bookmarkWrites(f).length, 1); assert.equal(bookmarkWrites(replacement).length, 1);
  assert.deepEqual(replacement.client.getAccountData(saved).getContent().events, [{ id: '$new', roomId: replacement.room.roomId }]);
});
test('real API account generation fences queued A to B to A work even when the Matrix client reference is unchanged', async () => {
  const { f, module, api } = setup(), gate = deferred(), entered = deferred(), send = f.client.setAccountData.bind(f.client);
  f.client.setAccountData = async (...args) => { entered.resolve(); await gate.promise; return send(...args); };
  const one = module.matrixApi('save', { id: '$first' }); await entered.promise; const two = module.matrixApi('save', { id: '$second' }); const old = Promise.allSettled([one, two]);
  const owner = api.accountArtworkOwner(); api.setAccountDevice('B'); api.setAccountDevice('A'); assert.notEqual(api.accountArtworkOwner(), owner); gate.resolve();
  assert.ok((await old).every(result => result.status === 'rejected' && /account changed/.test(result.reason.message))); assert.equal(bookmarkWrites(f).length, 1);
  f.client.setAccountData = send; await module.matrixApi('save', { id: '$new' }); assert.deepEqual(f.client.getAccountData(saved).getContent().events.map(event => event.id), ['$first', '$new']);
});
test('a delayed native DM creation cannot capture a replacement account when it finally queues classification', async () => {
  for (const replaceClient of [false, true]) {
    const { f, module, api, attach } = setup(), gate = deferred(), entered = deferred();
    f.client.createRoom = async () => { entered.resolve(); await gate.promise; return { room_id: '!created:local' }; };
    const work = module.matrixApi('create', { kind: 'dm', members: ['@new-peer:local'] }); const result = assert.rejects(work, /account changed/); await entered.promise;
    api.setAccountDevice('B'); api.setAccountDevice('A'); const replacement = replaceClient ? dmRequestsFixture() : f; if (replaceClient) attach(replacement);
    gate.resolve(); await result;
    assert.equal(replacement.calls.some(call => call.method === 'PUT' && call.path.endsWith('/account_data/m.direct')), false); assert.equal(f.calls.some(call => call.path.startsWith('/join/')), false);
  }
});
