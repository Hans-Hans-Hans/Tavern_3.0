import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { createMessageDraftStore } = loadTs('../lib/message-drafts.ts', {});
function fixture() {
  let current = { client: {}, account: {}, userId: '@alice:local', deviceId: 'D1' };
  const store = createMessageDraftStore(() => current);
  return { store, owner: store.owner(), change: value => { current = value; }, current: () => current };
}
test('navigation retains separate channel, DM and thread text without changing its whitespace', () => {
  const { store, owner } = fixture();
  for (const [room, parent, text] of [['!channel:local', '', 'Main draft'], ['!dm:local', '', 'DM draft'], ['!channel:local', '$one', 'Reply one'], ['!channel:local', '$two', '  Reply two\n']]) store.write(owner, room, parent, text);
  assert.equal(store.read(owner, '!channel:local').text, 'Main draft');
  assert.equal(store.read(owner, '!dm:local').text, 'DM draft');
  assert.equal(store.read(owner, '!channel:local', '$one').text, 'Reply one');
  assert.equal(store.read(owner, '!channel:local', '$two').text, '  Reply two\n');
  assert.equal(store.read(owner, '!other:local').text, '');
});
test('subscribers observe writes and acknowledged clears, with stable unchanged snapshots', () => {
  const { store, owner } = fixture(); let updates = 0;
  const stop = store.subscribe(() => updates++);
  store.write(owner, '!room:local', '', 'Draft'); const first = store.read(owner, '!room:local');
  store.write(owner, '!room:local', '', 'Draft'); assert.equal(store.read(owner, '!room:local'), first); assert.equal(updates, 1);
  assert.equal(store.clear(owner, '!room:local', '', first), true); assert.equal(updates, 2);
  stop(); store.write(owner, '!room:local', '', 'Next'); assert.equal(updates, 2);
});
test('late acknowledgement cannot clear edited, replaced or identically rewritten drafts', () => {
  const { store, owner } = fixture();
  store.write(owner, '!room:local', '', 'Sending'); const sent = store.read(owner, '!room:local');
  for (const text of ['Newer draft', '', 'Sending']) { store.write(owner, '!room:local', '', text); assert.equal(store.clear(owner, '!room:local', '', sent), false); assert.equal(store.read(owner, '!room:local').text, text); }
});
test('acknowledging a reply leaves the main draft and other replies untouched', () => {
  const { store, owner } = fixture();
  for (const parent of ['', '$one', '$two']) store.write(owner, '!room:local', parent, parent || 'Main');
  store.clear(owner, '!room:local', '$one', store.read(owner, '!room:local', '$one'));
  assert.equal(store.read(owner, '!room:local', '$one').text, '');
  assert.equal(store.read(owner, '!room:local').text, 'Main'); assert.equal(store.read(owner, '!room:local', '$two').text, '$two');
});
for (const field of ['client', 'account', 'userId', 'deviceId']) test(field + ' replacement retires all drafts and prevents stale writes or acknowledgements', () => {
  const f = fixture(); f.store.write(f.owner, '!room:local', '', 'Private old draft'); const sent = f.store.read(f.owner, '!room:local');
  f.change({ ...f.current(), [field]: field === 'userId' ? '@bob:local' : field === 'deviceId' ? 'D2' : {} });
  // No React commit or event dispatch is needed for the ownership fence.
  assert.equal(f.store.read(f.owner, '!room:local').text, ''); assert.equal(f.store.write(f.owner, '!room:local', '', 'Late old text'), false);
  const replacement = f.store.owner(); f.store.write(replacement, '!room:local', '', 'New account draft');
  assert.equal(f.store.clear(f.owner, '!room:local', '', sent), false); assert.equal(f.store.read(replacement, '!room:local').text, 'New account draft');
});
test('sign-out and account A to B to A never resurrect a retired draft owner', () => {
  const f = fixture(), initial = f.current(); f.store.write(f.owner, '!room:local', '', 'Old A');
  f.change(null); f.store.refresh(); assert.equal(f.store.owner(), null);
  f.change(initial); const again = f.store.owner(); assert.notEqual(again, f.owner); assert.equal(f.store.read(again, '!room:local').text, '');
  f.store.write(again, '!room:local', '', 'New A');
  f.change({ ...initial, account: {} }); assert.equal(f.store.read(again, '!room:local').text, '');
});
test('an old async callback retires visible drafts even before an external owner event arrives', async () => {
  const f = fixture(); f.store.write(f.owner, '!room:local', '', 'Old draft');
  const before = f.store.read(f.owner, '!room:local'); let visible = before.text;
  f.store.subscribe(() => { visible = f.store.read(f.store.owner(), '!room:local').text; });
  f.change({ ...f.current(), account: {} });
  assert.equal(f.store.clear(f.owner, '!room:local', '', before), false);
  await Promise.resolve(); assert.equal(visible, '');
});
