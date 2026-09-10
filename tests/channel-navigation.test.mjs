import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const model = loadTs('../lib/channel-navigation.ts', {});
const layout = () => ({ version: 1, categories: [{ id: 'a', name: 'Zulu', icon: '' }, { id: 'b', name: 'Alpha', icon: '' }], channels: [{ id: '!root:local', category: '' }, { id: '!one:local', category: 'a' }, { id: '!two:local', category: 'a' }, { id: '!voice:local', category: 'b' }] });
test('channel before/after moves persist exact array order within and across categories and root', () => {
  const original = layout(), before = structuredClone(original);
  const moved = model.moveNavigationItem(original, { kind: 'channel', id: '!voice:local' }, { kind: 'channel', id: '!one:local', edge: 'after' });
  assert.deepEqual(moved.channels.filter(c => c.category === 'a').map(c => c.id), ['!one:local', '!voice:local', '!two:local']);
  const root = model.moveNavigationItem(moved, { kind: 'channel', id: '!two:local' }, { kind: 'channel', id: '!root:local', edge: 'before' });
  assert.deepEqual(root.channels.filter(c => !c.category).map(c => c.id), ['!two:local', '!root:local']);
  const inside = model.moveNavigationItem(root, { kind: 'channel', id: '!root:local' }, { kind: 'category', id: 'b', edge: 'inside' });
  assert.equal(inside.channels.find(c => c.id === '!root:local').category, 'b');
  const uncategorized = model.moveNavigationItem(inside, { kind: 'channel', id: '!voice:local' }, { kind: 'root', id: '', edge: 'inside' });
  assert.deepEqual(uncategorized.channels.filter(c => !c.category).map(c => c.id), ['!two:local', '!voice:local']);
  assert.deepEqual(original, before);
});
test('category reordering changes only category order and deletion preserves every channel ID', () => {
  const original = layout(), next = model.moveNavigationItem(original, { kind: 'category', id: 'b' }, { kind: 'category', id: 'a', edge: 'before' });
  assert.deepEqual(next.categories.map(c => c.id), ['b', 'a']); assert.deepEqual(next.channels, original.channels);
  const removed = model.removeNavigationCategory(next, 'a');
  assert.deepEqual(removed.channels.map(c => c.id), original.channels.map(c => c.id));
  assert.ok(removed.channels.filter(c => ['!one:local', '!two:local'].includes(c.id)).every(c => c.category === ''));
});
test('stale IDs and incompatible drop targets fail rather than silently move somewhere else', () => {
  const value = layout();
  for (const [item, target] of [[{ kind: 'channel', id: '!gone:local' }, { kind: 'root', edge: 'inside' }], [{ kind: 'channel', id: '!one:local' }, { kind: 'category', id: 'gone', edge: 'inside' }], [{ kind: 'category', id: 'a' }, { kind: 'channel', id: '!one:local', edge: 'before' }]]) assert.throws(() => model.moveNavigationItem(value, item, target));
  assert.equal(model.moveNavigationItem(value, { kind: 'channel', id: '!one:local' }, { kind: 'channel', id: '!one:local', edge: 'after' }), value);
});
test('category dialogs retain stable IDs, validate bounds and do not reorder by renamed text', () => {
  const renamed = model.editNavigationCategory(layout(), 'a', ' New name ', '📁');
  assert.deepEqual(renamed.categories.map(c => c.id), ['a', 'b']); assert.equal(renamed.categories[0].name, 'New name');
  const created = model.editNavigationCategory(renamed, 'c', 'Games', '', true); assert.deepEqual(created.categories.map(c => c.id), ['a', 'b', 'c']);
  assert.throws(() => model.editNavigationCategory(created, 'c', 'Again', '', true));
  assert.throws(() => model.editNavigationCategory(created, 'c', ' ', '')); assert.throws(() => model.editNavigationCategory(created, 'c', 'x'.repeat(61), ''));
  assert.equal(model.rowDropEdge(14, 0, 30), 'before'); assert.equal(model.rowDropEdge(16, 0, 30), 'after');
});
