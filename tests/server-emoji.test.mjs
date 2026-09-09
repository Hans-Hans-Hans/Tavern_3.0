import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { cleanMxc } = loadTs('../lib/community.ts', { './matrix': {} });
const { parseServerEmoji, tokenizeServerEmoji, serverEmojiHtml } = loadTs('../lib/server-emoji.ts', { './matrix': {}, './community': { cleanMxc } });
test('emoji state rejects external URLs, duplicate names, and invalid identifiers', () => { const value = parseServerEmoji({ emoji: [{ name: 'cheers', uri: 'mxc://local/media' }, { name: 'cheers', uri: 'mxc://local/second' }, { name: 'tracker', uri: 'https://track.example/pixel' }, { name: 'bad<script>', uri: 'mxc://local/media' }] }); assert.deepEqual(value, [{ name: 'cheers', uri: 'mxc://local/media', creator: '' }]); });
test('known emoji tokens preserve all other text without interpreting markup', () => { const emojis = [{ name: 'cheers', uri: 'mxc://local/id' }]; assert.deepEqual(tokenizeServerEmoji('Hello :cheers: :unknown:', emojis), [{ text: 'Hello ' }, { emoji: emojis[0] }, { text: ' :unknown:' }]); const html = serverEmojiHtml('<script>alert(1)</script> :cheers:', emojis); assert.ok(html.startsWith('&lt;script&gt;')); assert.ok(html.includes('data-mx-emoticon')); assert.ok(!html.includes('<script>')); });
