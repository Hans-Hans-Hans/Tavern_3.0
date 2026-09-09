import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as sdk from 'matrix-js-sdk';
import { loadTs } from '../load-ts.mjs';

/** Run the actual Matrix read API/normalizer with an injected SDK session.
 * Test-only hooks are appended in memory; production exports are unchanged. */
export function matrixThreadReader(client) {
  const resolver = loadTs('../lib/resolve-event.ts', {});
  const dependencies = {
    './resolve-event': resolver,
    './thread-history': loadTs('../lib/thread-history.ts', { 'matrix-js-sdk': sdk, './resolve-event': resolver }),
    './room-read-scope': loadTs('../lib/room-read-scope.ts', {}),
    './message-projection': loadTs('../lib/message-projection.ts', {}),
    './webhook-metadata': { webhookMetadata: () => null },
    './api': { accountArtworkOwner: () => accountOwner },
  };
  let accountOwner = {};
  dependencies['./thread-participants'] = loadTs('../lib/thread-participants.ts', { 'matrix-js-sdk': sdk, './thread-history': dependencies['./thread-history'] });
  const source = readFileSync(new URL('../../lib/matrix.ts', import.meta.url), 'utf8') + '\nexport function fixtureClient(value:any,moduleSdk:any){client=value;if(moduleSdk)sdk=moduleSdk;eventCache.clear();}\nexport function fixtureCache(event:any){eventCache.set(event.getId(),event);}\nexport function fixtureCacheIds(){return [...eventCache.keys()];}';
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('require', 'exports', compiled)(name => dependencies[name] || new Proxy({}, { get: (_value, key) => { throw new Error(`Unexpected dependency in Matrix read fixture: ${name}.${String(key)}`); } }), exports);
  exports.fixtureClient(client, sdk);
  exports.fixtureAccountChanged = () => { accountOwner = {}; };
  return exports;
}
