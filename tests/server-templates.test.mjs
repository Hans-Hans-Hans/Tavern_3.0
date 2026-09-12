import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { serverTemplates, starterCategories, validateStarterChannels } = loadTs('../lib/server-templates.ts', {});

test('all eight layouts reference real categories and fit the bounded creation model', () => {
  assert.deepEqual(Object.keys(serverTemplates), ['blank', 'friends', 'gaming', 'community', 'team', 'development', 'study', 'custom']);
  const kinds = new Set(['text', 'voice', 'video', 'forum', 'announcement', 'rules', 'media', 'read-only']);
  for (const template of Object.values(serverTemplates)) {
    const categories = starterCategories(template.categories);
    validateStarterChannels(template.channels, categories);
    assert.equal(template.channels.every(channel => kinds.has(channel.kind)), true);
  }
  assert.equal(serverTemplates.blank.channels.length, 0);
  assert.equal(serverTemplates.community.channels.some(channel => channel.kind === 'rules'), true);
});

test('layout preflight rejects duplicate names, invalid categories and oversized drafts', () => {
  const template = serverTemplates.friends;
  for (const categories of [null, [...template.categories, template.categories[0]], [{ id: 'x', name: ' ', icon: '' }], [{ id: 'x', name: 'a\nb', icon: '' }], Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: String(i), icon: '' }))]) assert.throws(() => starterCategories(categories));
  for (const channels of [[template.channels[0], { ...template.channels[0], id: 'second', name: ' GENERAL ' }], [{ ...template.channels[0], category: 'missing' }], [{ ...template.channels[0], name: '' }], [{ ...template.channels[0], description: 'x'.repeat(501) }], Array.from({ length: 25 }, (_, i) => ({ ...template.channels[0], id: String(i), name: String(i) }))]) assert.throws(() => validateStarterChannels(channels, template.categories));
  validateStarterChannels([{ ...template.channels[0], category: '' }], []);
  assert.deepEqual(starterCategories(undefined), []);
});
