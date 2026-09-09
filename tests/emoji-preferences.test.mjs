import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { normalizeEmojiPreferences, applyEmojiTone, recordEmojiUse, toggleFavoriteEmoji } = loadTs('../lib/emoji-preferences.ts', {});
test('emoji tones apply only to supported modifier bases without corrupting complex emoji', () => { assert.equal(applyEmojiTone('👍', '🏽'), '👍🏽'); assert.equal(applyEmojiTone('👍🏽', '🏻'), '👍🏻'); assert.equal(applyEmojiTone('✌️', ''), '✌️'); assert.equal(applyEmojiTone('🍺', '🏾'), '🍺'); assert.equal(applyEmojiTone('🏳️‍🌈', '🏽'), '🏳️‍🌈'); });
test('emoji frequency, recency and favorites remain distinct and bounded', () => { let p = normalizeEmojiPreferences({ counts: { '<script>': 3, '🍺': Infinity }, favorites: ['👍', '👍', 'https://tracker'], tone: 'invalid' }); assert.deepEqual(p.favorites, ['👍']); assert.deepEqual(p.counts, {}); p = recordEmojiUse(recordEmojiUse(recordEmojiUse(p, '🍺'), '👍'), '🍺'); assert.deepEqual(p.recent, ['🍺', '👍']); assert.equal(p.counts['🍺'], 2); p = toggleFavoriteEmoji(p, '🍺'); assert.deepEqual(p.favorites, ['👍', '🍺']); assert.deepEqual(toggleFavoriteEmoji(p, '👍').favorites, ['🍺']); });
