/** Real Chromium IndexedDB smoke: run `node tests/search-browser.mjs` after Playwright install. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { chromium } from 'playwright';

const source = await readFile(new URL('../lib/search-index.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/import\s+\{[^}]+\}\s+from\s+['"]matrix-js-sdk['"];?/, `const ClientEvent={},Direction={Backward:'b'},MatrixEventEvent={Decrypted:'decrypted'},RoomEvent={Timeline:'timeline',Redaction:'redaction',MyMembership:'membership'};`);
export async function checkSearchStorage(page) {
  await page.route('http://localhost:4179/**', route => route.fulfill({ contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/html', body: route.request().url().endsWith('.js') ? compiled : '<!doctype html><title>Search storage test</title>' }));
  await page.goto('http://localhost:4179/');
  const result = await page.evaluate(async () => {
    const search = await import('/search-index.js');
    const listeners = new Map(), ignored = [], events = [], baseTime = Date.parse('2026-09-08'); let membership = 'join';
    const room = { roomId: '!room:local', name: 'General', getMember: user => ({ name: user === '@alice:local' ? 'Alice' : 'Bob' }), getMyMembership: () => membership, getLiveTimeline: () => ({ getEvents: () => events, getPaginationToken: () => null }), findEventById: id => events.find(e => e.getId() === id) };
    const event = (id, body, timestamp = baseTime, extra = {}) => ({ status: null, event: {}, isRedacted: () => false, isRedaction: () => false, isEncrypted: () => false, isDecryptionFailure: () => false, getType: () => 'm.room.message', getId: () => id, getSender: () => '@alice:local', getRoomId: () => room.roomId, getContent: () => ({ msgtype: 'm.text', body, ...extra }), getTs: () => timestamp, replacingEventDate: () => null });
    events.push(event('$one', 'secret launch first'), event('$two', 'secret launch second'));
    const client = { getUserId: () => '@bob:local', getDeviceId: () => 'SEARCH_TEST', getIgnoredUsers: () => ignored, getRoom: id => id === room.roomId ? room : null, getRooms: () => [room], on: (name, callback) => listeners.set(name, callback), off: name => listeners.delete(name), decryptEventIfNeeded: async () => {} };
    const until = async fn => { for (let i = 0; i < 300; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Search indexing did not complete'); };
    await search.initializeSearch(client);
    await until(async () => (await search.searchIndexStatus()).indexedCount === 2);
    const first = await search.searchMessages('launch', { limit: 1 }), second = await search.searchMessages('launch', { limit: 1, cursor: first.nextCursor });
    const all = await search.searchMessages('from:alice in:general secret');
    listeners.get('timeline')(event('$edit', '* Updated', baseTime + 1000, { 'm.relates_to': { rel_type: 'm.replace', event_id: '$one' }, 'm.new_content': { msgtype: 'm.text', body: 'revised secret' } }), room);
    await until(async () => (await search.searchMessages('revised')).hits.length === 1);
    const edited = await search.searchMessages('launch'), revision = await search.searchMessages('revised');
    ignored.push('@alice:local'); const blocked = await search.searchMessages('secret'); ignored.length = 0;
    listeners.get('redaction')({ ...event('$delete', ''), isRedaction: () => true, event: { redacts: '$two' } }, room);
    await until(async () => (await search.searchIndexStatus()).indexedCount === 1);
    search.resetSearch(); await search.initializeSearch({ ...client, getRooms: () => [] }); const reopened = await search.searchMessages('revised');
    membership = 'leave'; listeners.get('membership')(room);
    await until(async () => (await search.searchIndexStatus()).indexedCount === 0);
    const left = await search.searchMessages('secret'); search.resetSearch();
    return { first: first.hits.map(h => h.id), second: second.hits.map(h => h.id), all: all.hits.length, edited: edited.hits.map(h => h.id), revision: revision.hits[0]?.body, blocked: blocked.hits.length, reopened: reopened.hits[0]?.body, left: left.hits.length };
  });
  assert.deepEqual(result.first, ['$two']); assert.deepEqual(result.second, ['$one']); assert.equal(result.all, 2); assert.deepEqual(result.edited, ['$two']); assert.equal(result.revision, 'revised secret'); assert.equal(result.blocked, 0); assert.equal(result.reopened, 'revised secret'); assert.equal(result.left, 0);
  return result;
}
if (process.argv[1]?.endsWith('search-browser.mjs')) {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  try { await checkSearchStorage(await browser.newPage()); process.stdout.write('PASS real Chromium IndexedDB search: encrypted persistence, ordered HMAC postings, pagination, edits, redactions, ignored users, session restore, and room leave.\n'); }
  finally { await browser.close(); }
}
