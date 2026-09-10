import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { conferenceHomeserverUrl } = loadTs('../lib/conference-url.ts', {});
test('only the exact same-origin managed gateway is replaced by public Matrix discovery', () => {
  for (const url of ['https://tavern.test/api/matrix', 'https://tavern.test/api/matrix/']) assert.equal(conferenceHomeserverUrl(url, 'https://tavern.test'), 'https://tavern.test');
  for (const url of ['https://tavern.test', 'https://matrix.other.test/api/matrix', 'http://tavern.test/api/matrix', 'https://tavern.test/api/matrix/other', 'https://tavern.test/api/matrix?x=1']) assert.equal(conferenceHomeserverUrl(url, 'https://tavern.test'), url);
});
