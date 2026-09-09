import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../lib/pwa.ts', import.meta.url), 'utf8').replace('import.meta.env.PROD', 'true'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function worker(state) { return Object.assign(new EventTarget(), { state, scriptURL: 'https://tavern.test/sw.js', postMessage() { throw new Error('Unexpected activation request'); } }); }
async function setup(registration) {
  const serviceWorker = Object.assign(new EventTarget(), { register: async () => registration });
  const window = Object.assign(new EventTarget(), { isSecureContext: true });
  let reloads = 0;
  const exports = {};
  vm.runInNewContext(source, { exports, require: () => { throw new Error('Unexpected session import'); }, window, navigator: { onLine: true, serviceWorker }, document: new EventTarget(), matchMedia: () => Object.assign(new EventTarget(), { matches: false }), fetch: async () => ({ ok: true }), AbortSignal, URL, setTimeout, clearTimeout, location: { origin: 'https://tavern.test', reload: () => { reloads++; } } });
  exports.initializePwa();
  await new Promise(resolve => setImmediate(resolve));
  return { api: exports, serviceWorker, reloads: () => reloads };
}

test('first installation never offers an update; a later waiting replacement does', async () => {
  const first = worker('installing');
  const registration = Object.assign(new EventTarget(), { active: null, waiting: null, installing: first });
  const { api, serviceWorker, reloads } = await setup(registration);
  registration.waiting = first; first.state = 'installed'; first.dispatchEvent(new Event('statechange'));
  assert.equal(api.pwaSnapshot().updateAvailable, false);
  await api.applyAppUpdate(); // A first install must not request coordinated activation.
  registration.active = first; registration.waiting = null; registration.installing = null; first.state = 'activated'; first.dispatchEvent(new Event('statechange')); serviceWorker.dispatchEvent(new Event('controllerchange'));
  assert.equal(api.pwaSnapshot().updateAvailable, false); assert.equal(reloads(), 0);
  const second = worker('installing'); registration.installing = second; registration.dispatchEvent(new Event('updatefound'));
  registration.waiting = second; second.state = 'installed'; second.dispatchEvent(new Event('statechange'));
  assert.equal(api.pwaSnapshot().updateAvailable, true);
  registration.active = second; registration.waiting = null; second.state = 'activated'; second.dispatchEvent(new Event('statechange'));
  assert.equal(api.pwaSnapshot().updateAvailable, false); assert.equal(reloads(), 0);
});

test('an update already waiting when registration resolves is tracked until discarded', async () => {
  const replacement = worker('installed');
  const registration = Object.assign(new EventTarget(), { active: worker('activated'), waiting: replacement, installing: null });
  const { api, reloads } = await setup(registration);
  assert.equal(api.pwaSnapshot().updateAvailable, true);
  registration.waiting = null; replacement.state = 'redundant'; replacement.dispatchEvent(new Event('statechange'));
  assert.equal(api.pwaSnapshot().updateAvailable, false); assert.equal(reloads(), 0);
});
