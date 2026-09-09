import { test, expect, type Page } from '@playwright/test';
import { prepareSearchStoragePage } from '../search-browser.mjs';

async function fixture(page: Page) {
  await prepareSearchStoragePage(page);
  await page.evaluate(async () => {
    const search = await import('/search-index.js');
    const f = (window as any).historyFixture = { actor: '@reader:local', device: 'HISTORY', membership: 'join', pages: [], requests: [], mapped: [], progress: [], result: null };
    const room = { roomId: '!history:local', name: 'History', getMember: () => ({ name: 'Writer' }), getMyMembership: () => f.membership,
      getLiveTimeline: () => ({ getEvents: () => [], getPaginationToken: () => 'start' }), findEventById: () => undefined };
    f.room = room;
    const client = { getUserId: () => f.actor, getDeviceId: () => f.device, getIgnoredUsers: () => [], getRooms: () => [room], getRoom: () => f.room,
      on() {}, off() {},
      createMessagesRequest: async (id: string, token: string, limit: number, direction: string) => {
        f.requests.push({ id, token, limit, direction });
        if (f.holdPage) await new Promise<void>(resolve => { f.releasePage = resolve; });
        if (!f.pages.length) throw new Error('Unexpected additional history request');
        return f.pages.shift();
      },
      decryptEventIfNeeded: async (event: any) => {
        if (event.getRoomId() !== room.roomId) throw new Error('Missing decryption room context');
        if (f.holdDecrypt) await new Promise<void>(resolve => { f.releaseDecrypt = resolve; });
        event.clear = event.raw.plain;
      },
      getEventMapper: () => (raw: any) => {
        f.mapped.push(raw.room_id);
        return { raw, status: null, event: raw, isRedacted: () => false, isRedaction: () => false,
          isEncrypted: () => raw.type === 'm.room.encrypted', isDecryptionFailure() { return this.isEncrypted() && !this.clear; },
          getType() { return this.clear ? 'm.room.message' : raw.type; }, getRoomId: () => raw.room_id,
          getId: () => raw.event_id, getSender: () => raw.sender, getTs: () => raw.origin_server_ts,
          getContent() { return this.clear || raw.content; }, replacingEventDate: () => null };
      },
    };
    const owner = f.owner = {};
    await search.initializeSearch(client, () => f.owner === owner); f.search = search; f.controller = new AbortController();
    f.start = () => { void search.indexRoomHistory(room.roomId, (value: any) => f.progress.push(value), f.controller.signal)
      .then((value: any) => { f.result = { ok: true, ...value }; }, (error: Error) => { f.result = { ok: false, error: error.message }; }); };
  });
}
const event = (id: string, extra = {}) => ({ event_id: id, sender: '@writer:local', origin_server_ts: 123, type: 'm.room.encrypted', plain: { msgtype: 'm.text', body: 'Older searchable secret' }, ...extra });

test('a stale initializer cannot close a replacement account index or create its old device database', async ({ page }) => {
  await fixture(page);
  await page.evaluate(raw => { const f = (window as any).historyFixture; f.pages = [{ chunk: [raw] }]; f.start(); }, event('$replacement'));
  await expect.poll(() => page.evaluate(() => (window as any).historyFixture.result?.ok)).toBe(true);
  const result = await page.evaluate(async () => {
    const f = (window as any).historyFixture, before = (await indexedDB.databases()).map(value => value.name);
    const stale = { getUserId: () => '@old:local', getDeviceId: () => 'OLD_DEVICE', getRooms: () => [], on() {}, off() {} };
    await f.search.initializeSearch(stale, () => false);
    return { hits: (await f.search.searchMessages('searchable')).hits.map((hit: any) => hit.id),
      before, after: (await indexedDB.databases()).map(value => value.name) };
  });
  expect(result.hits).toEqual(['$replacement']); expect(result.after).toEqual(result.before);
});

test('empty advancing pages reach encrypted older messages and supply the scoped decryption room', async ({ page }) => {
  await fixture(page);
  await page.evaluate(pages => { const f = (window as any).historyFixture; f.pages = pages; f.start(); }, [{ chunk: [], end: 'filtered' }, { chunk: [], end: 'older' }, { chunk: [event('$old')] }]);
  await expect.poll(() => page.evaluate(() => (window as any).historyFixture.result)).toEqual({ ok: true, indexed: 1, complete: true });
  const result = await page.evaluate(async () => { const f = (window as any).historyFixture; return { tokens: f.requests.map((r: any) => r.token), mapped: f.mapped, hits: (await f.search.searchMessages('searchable')).hits.map((hit: any) => hit.id) }; });
  expect(result).toEqual({ tokens: ['start', 'filtered', 'older'], mapped: ['!history:local'], hits: ['$old'] });
});

test('empty cursor cycles and invalid pages fail without claiming the history is complete', async ({ page }) => {
  for (const pages of [
    [{ chunk: [], end: 'one' }, { chunk: [], end: 'two' }, { chunk: [], end: 'one' }],
    [{ chunk: [], end: null }], [{ chunk: [], end: '' }], [{ chunk: {} }],
    [{ chunk: [event('$wrong', { room_id: '!different:local' })] }],
  ]) {
    await fixture(page);
    await page.evaluate(pages => { const f = (window as any).historyFixture; f.pages = pages; f.start(); }, pages);
    await expect.poll(() => page.evaluate(() => (window as any).historyFixture.result?.ok)).toBe(false);
    expect(await page.evaluate(() => (window as any).historyFixture.progress.some((p: any) => p.complete))).toBe(false);
    expect(await page.evaluate(async () => (await (window as any).historyFixture.search.searchIndexStatus()).indexedCount)).toBe(0);
  }
});

test('history indexing stops at twenty pages with an explicit cursor and continues only on request', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).historyFixture; f.pages = Array.from({ length: 21 }, (_, index) => ({ chunk: [], end: 'older-' + index })); f.start(); });
  await expect.poll(() => page.evaluate(() => (window as any).historyFixture.result)).toEqual({ ok: true, indexed: 0, complete: false, nextCursor: 'older-19' });
  expect(await page.evaluate(() => (window as any).historyFixture.requests.length)).toBe(20);
  const result = await page.evaluate(async raw => { const f = (window as any).historyFixture; f.pages = [{ chunk: [raw] }]; return f.search.indexRoomHistory(f.room.roomId, undefined, f.controller.signal, { cursor: f.result.nextCursor }); }, event('$continued'));
  expect(result).toEqual({ indexed: 1, complete: true });
  expect(await page.evaluate(() => (window as any).historyFixture.requests.at(-1).token)).toBe('older-19');
});

test('API owner generation changes discard an in-flight index page even if native actor and device return unchanged', async ({ page }) => {
  await fixture(page);
  await page.evaluate(raw => { const f = (window as any).historyFixture; f.pages = [{ chunk: [raw] }]; f.holdDecrypt = true; f.start(); }, event('$old-api'));
  await page.waitForFunction(() => typeof (window as any).historyFixture.releaseDecrypt === 'function');
  await page.evaluate(() => { const f = (window as any).historyFixture; f.owner = {}; f.owner = {}; f.releaseDecrypt(); });
  await expect.poll(() => page.evaluate(() => (window as any).historyFixture.result?.ok)).toBe(false);
  expect(await page.evaluate(async () => (await (window as any).historyFixture.search.searchIndexStatus()).indexedCount)).toBe(0);
});

test('account, room and membership changes or cancellation while a page waits discard its result', async ({ page }) => {
  for (const change of ['actor', 'device', 'room', 'membership', 'cancel']) {
    await fixture(page);
    await page.evaluate(raw => { const f = (window as any).historyFixture; f.pages = [{ chunk: [raw] }]; f.holdPage = true; f.start(); }, event('$late'));
    await page.waitForFunction(() => typeof (window as any).historyFixture.releasePage === 'function');
    await page.evaluate(change => {
      const f = (window as any).historyFixture;
      if (change === 'actor') f.actor = '@other:local';
      else if (change === 'device') f.device = 'OTHER';
      else if (change === 'room') f.room = { ...f.room };
      else if (change === 'membership') f.membership = 'leave';
      else f.controller.abort();
      f.releasePage();
    }, change);
    await expect.poll(() => page.evaluate(() => (window as any).historyFixture.result?.ok)).toBe(false);
    expect(await page.evaluate(() => (window as any).historyFixture.mapped)).toEqual([]);
  }
});

test('same-client identity change during decryption cannot persist the old search document', async ({ page }) => {
  await fixture(page);
  await page.evaluate(raw => { const f = (window as any).historyFixture; f.pages = [{ chunk: [raw] }]; f.holdDecrypt = true; f.start(); }, event('$decrypting'));
  await page.waitForFunction(() => typeof (window as any).historyFixture.releaseDecrypt === 'function');
  await page.evaluate(() => { const f = (window as any).historyFixture; f.actor = '@other:local'; f.releaseDecrypt(); });
  await expect.poll(() => page.evaluate(() => (window as any).historyFixture.result?.ok)).toBe(false);
  expect(await page.evaluate(async () => (await (window as any).historyFixture.search.searchIndexStatus()).indexedCount)).toBe(0);
});

test('room replacement during decryption cannot persist a document from the discarded room', async ({ page }) => {
  await fixture(page);
  await page.evaluate(raw => { const f = (window as any).historyFixture; f.pages = [{ chunk: [raw] }]; f.holdDecrypt = true; f.start(); }, event('$old-room'));
  await page.waitForFunction(() => typeof (window as any).historyFixture.releaseDecrypt === 'function');
  await page.evaluate(() => { const f = (window as any).historyFixture; f.room = { ...f.room }; f.releaseDecrypt(); });
  await expect.poll(() => page.evaluate(() => (window as any).historyFixture.result?.ok)).toBe(false);
  expect(await page.evaluate(async () => (await (window as any).historyFixture.search.searchIndexStatus()).indexedCount)).toBe(0);
});

test('the final IndexedDB read-to-write continuation rechecks the actor before storing ciphertext', async ({ page }) => {
  await fixture(page);
  await page.evaluate(raw => {
    const f = (window as any).historyFixture, original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const request = original.call(this, key);
      if (this.name === 'documents' && this.transaction.mode === 'readwrite') {
        request.addEventListener('success', () => { f.actor = '@other:local'; }, { once: true });
        IDBObjectStore.prototype.get = original;
      }
      return request;
    };
    f.pages = [{ chunk: [raw] }]; f.start();
  }, event('$before-put'));
  await expect.poll(() => page.evaluate(() => (window as any).historyFixture.result?.ok)).toBe(false);
  expect(await page.evaluate(async () => (await (window as any).historyFixture.search.searchIndexStatus()).indexedCount)).toBe(0);
});
