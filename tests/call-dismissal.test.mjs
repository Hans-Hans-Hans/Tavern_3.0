import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { createCallDismissals } = loadTs('../lib/call-dismissal.ts', {});
const owner = ['https://local/api/matrix', '@alice:local', 'ONE'];
function fixture() {
  const values = new Map(); let time = 1000000;
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  return { values, storage, now: () => time, advance: delta => { time += delta; }, make: (who = owner) => createCallDismissals(who, storage, () => time) };
}
test('a fresh module after refresh suppresses the same handled invite only for its native account and device', () => {
  const f = fixture(), first = f.make(); first.remember('opaque-handled-call');
  const reloaded = f.make(); assert.equal(reloaded.has('opaque-handled-call'), true);
  assert.equal(reloaded.has('different-new-call'), false);
  for (const who of [[owner[0], owner[1], 'TWO'], [owner[0], '@bob:local', 'ONE'], ['https://other/api/matrix', owner[1], 'ONE']]) assert.equal(f.make(who).has('opaque-handled-call'), false);
  f.advance(15 * 60_000); assert.equal(f.make().has('opaque-handled-call'), false);
});
test('handled call storage is bounded, ignores corrupted or future entries and does not block hangup when storage fails', () => {
  const f = fixture(), seen = f.make();
  for (let i = 0; i < 150; i++) seen.remember('call-' + i);
  assert.equal(f.make().has('call-0'), false); assert.equal(f.make().has('call-149'), true);
  assert.equal(JSON.parse([...f.values.values()][0]).length, 128);
  seen.remember('bad\ncall'); assert.equal(seen.has('bad\ncall'), false);
  f.advance(-1); assert.equal(f.make().has('call-149'), false);
  const unavailable = createCallDismissals(owner, { getItem() { throw Error(); }, setItem() { throw Error(); } });
  assert.doesNotThrow(() => unavailable.remember('handled')); assert.equal(unavailable.has('handled'), true);
});
