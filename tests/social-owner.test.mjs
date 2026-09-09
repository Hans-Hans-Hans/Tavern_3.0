import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

function fixture() {
  const api = loadTs('../lib/api.ts', { './image-cache': { disposeCachedImageOwner() {} }, './response-image': {}, './web-push': { startWebPushSession() {}, stopWebPushSession() {} } }); api.setAccountDevice('A');
  const f = { client: { getUserId: () => '@owner:local' }, request: async () => ({ requests: [], blocked: [], privacy: 'everyone', hasMore: false }) };
  f.model = loadTs('../lib/social.ts', { './api': { ...api, requestApi: (...args) => f.request(...args) }, './matrix': { getMatrixClient: () => f.client } }); f.api = api; return f;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('social responses reject after API A to B to A or Matrix client replacement', async () => {
  for (const replacement of ['generation', 'client']) {
    const f = fixture(), gate = deferred(); f.request = () => gate.promise; const work = f.model.socialApi();
    if (replacement === 'generation') { f.api.setAccountDevice('B'); f.api.setAccountDevice('A'); } else f.client = { ...f.client };
    gate.resolve({ requests: [{ sender: '@old:local' }] }); await assert.rejects(work, /account changed/);
  }
});
test('contact streams are generation-bound and old unsubscribe cannot close a replacement stream', t => {
  const original = globalThis.EventSource, streams = [];
  globalThis.EventSource = class { constructor(url) { this.url = url; this.closed = false; streams.push(this); } close() { this.closed = true; } };
  t.after(() => { globalThis.EventSource = original; });
  const f = fixture(), calls = [], stopA = f.model.observeContacts(() => calls.push('A')), oldMessage = streams[0].onmessage;
  oldMessage(); assert.deepEqual(calls, ['A']); f.api.setAccountDevice('B'); f.api.setAccountDevice('A');
  const stopNew = f.model.observeContacts(() => calls.push('new-A')); assert.equal(streams[0].closed, true); assert.equal(streams.length, 2);
  oldMessage(); stopA(); assert.equal(streams[1].closed, false); streams[1].onmessage(); assert.deepEqual(calls, ['A', 'new-A']); stopNew(); assert.equal(streams[1].closed, true);
});
test('a contact stream receiving an event after account invalidation closes without refreshing that account', t => {
  const original = globalThis.EventSource, streams = []; globalThis.EventSource = class { constructor() { streams.push(this); } close() { this.closed = true; } }; t.after(() => { globalThis.EventSource = original; });
  const f = fixture(); let calls = 0; const stop = f.model.observeContacts(() => calls++); f.api.setAccountDevice('B'); streams[0].onmessage(); assert.equal(calls, 0); assert.equal(streams[0].closed, true); stop();
});
