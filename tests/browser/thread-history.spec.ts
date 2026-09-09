import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, empty = false) {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const getMatrixClient=()=>window.fixtureHistory?.state.current?window.fixtureHistory.client:null;export const onMatrixUpdate=fn=>{window.fixtureHistoryListeners.add(fn);return()=>window.fixtureHistoryListeners.delete(fn)};export const loadThreadHistory=()=>window.fixtureHistoryOlder();export const threadHasOlder=()=>window.fixtureHistoryHasOlder();export const discoverMatrixThreadParticipants=(_room,_root,options)=>window.fixtureHistoryDiscover(options);` }));
  await page.route('**/thread-history-test*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/thread-history.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/thread-history-test' + (empty ? '?empty' : ''));
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Thread notifications' })).toBeVisible();
}

test('the existing thread history control loads encrypted historical replies from a cached root through actual SDK timelines', async ({ page }) => {
  await fixture(page); expect(await page.evaluate(() => (window as any).fixtureInitialRootLoaded)).toBe(false);
  await expect(page.getByRole('list', { name: 'Loaded thread replies' }).getByRole('listitem')).toHaveText(['Latest encrypted reply']);
  await page.getByRole('button', { name: 'Load 50 earlier replies' }).click();
  await expect(page.getByRole('list', { name: 'Loaded thread replies' }).getByRole('listitem')).toHaveText(['First historical encrypted reply', 'Second historical encrypted reply', 'Latest encrypted reply']);
  await expect(page.getByRole('button', { name: 'Load 50 earlier replies' })).toHaveCount(0);
  const native = await page.evaluate(() => { const f = (window as any).fixtureHistory, thread = f.room.getThread(f.rootId); return { initialized: thread.initialEventsFetched, encrypted: thread.events.every((event: any) => event.isEncrypted()), requests: f.requests.filter((url: URL) => url.pathname.includes('/relations/')).map((url: URL) => ({ path: url.pathname, from: url.searchParams.get('from'), limit: url.searchParams.get('limit') })) }; });
  expect(native.initialized).toBe(true); expect(native.encrypted).toBe(true); expect(native.requests).toHaveLength(2); expect(native.requests[1].from).toBe('older-replies'); expect(native.requests[1].limit).toBe('50'); expect(native.requests.some((request: any) => request.path.includes('/m.room.message'))).toBe(false);
});

test('an empty initialized thread stays usable without a missing latest-message error', async ({ page }) => {
  await fixture(page, true); await expect(page.getByText('No replies yet.')).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Load 50 earlier replies' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).fixtureHistory.requests.filter((url: URL) => url.pathname.includes('/relations/')).length)).toBe(0);
});

test('native history denial remains an explicit retryable error in the existing thread tools', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Deny next history page' }).click(); await page.getByRole('button', { name: 'Load 50 earlier replies' }).click();
  await expect(page.getByRole('alert')).toContainText('History access was denied'); await expect(page.getByText('Latest encrypted reply', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Allow history again' }).click(); await page.getByRole('button', { name: 'Load 50 earlier replies' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.getByText('First historical encrypted reply', { exact: true })).toBeVisible();
});

test('an account change during an older page prevents late replies reaching the rendered projection', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Pause history page' }).click(); await page.getByRole('button', { name: 'Load 50 earlier replies' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixtureHistory.requests.filter((url: URL) => url.searchParams.has('from')).length)).toBe(1);
  await page.getByRole('button', { name: 'Change account' }).click(); await page.evaluate(() => (window as any).fixtureReleaseHistory());
  await expect(page.getByRole('status')).toContainText('account or room access changed'); await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.getByText('First historical encrypted reply', { exact: true })).toHaveCount(0);
});

test('participant discovery finds historical native senders, searches names and indexes available decrypted replies', async ({ page }) => {
  await fixture(page);
  await page.getByText('1 participant found', { exact: true }).click();
  await expect(page.getByRole('list', { name: 'Thread participants' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Discover earlier participants' }).click();
  await expect(page.getByText('3 participants found', { exact: true })).toBeVisible();
  const participants = page.getByRole('list', { name: 'Thread participants' });
  await expect(participants).toContainText('Historical author'); await expect(participants).toContainText('Not currently joined');
  await expect(page.getByRole('status')).toContainText('beginning');
  await page.getByRole('textbox', { name: 'Search thread participants' }).fill('historical author');
  await expect(participants.getByRole('listitem')).toHaveCount(1); await expect(participants).toContainText('@first:local');
  await page.getByRole('textbox', { name: 'Search thread participants' }).fill('@second:local');
  await expect(participants.getByRole('listitem')).toHaveCount(1);
  await expect.poll(() => page.evaluate(async () => (await (window as any).fixtureSearch.searchMessages('historical encrypted')).hits.map((hit: any) => hit.id).sort())).toEqual(['$first', '$second']);
  expect(await page.evaluate(() => (window as any).fixtureHistory.requests.filter((url: URL) => url.searchParams.get('from')).length)).toBe(1);
});

test('undecryptable historical replies still identify native authors without adding searchable plaintext', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { (window as any).fixtureHistory.client.decryptEventIfNeeded = async () => {}; });
  await page.getByText('1 participant found', { exact: true }).click(); await page.getByRole('button', { name: 'Discover earlier participants' }).click();
  await expect(page.getByText('3 participants found', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Loaded thread replies' })).not.toContainText('First historical encrypted reply');
  expect(await page.evaluate(async () => (await (window as any).fixtureSearch.searchMessages('historical encrypted')).hits.length)).toBe(0);
});

test('discovery reaches its page bound explicitly and can continue through empty advancing pages', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).fixtureHistory; let number = 0; f.state.historyPages = () => ++number <= 20 ? { chunk: [], next_batch: 'page-' + number } : { chunk: [f.first] }; });
  await page.getByText('1 participant found', { exact: true }).click(); await page.getByRole('button', { name: 'Discover earlier participants' }).click();
  await expect(page.getByRole('status')).toContainText('Loaded 20 pages');
  await page.getByRole('button', { name: 'Continue participant discovery' }).click();
  await expect(page.getByText('2 participants found', { exact: true })).toBeVisible(); await expect(page.getByRole('status')).toContainText('beginning');
});

test('native denial remains retryable and cancellation stops late discovery progress', async ({ page }) => {
  await fixture(page); await page.getByText('1 participant found', { exact: true }).click();
  await page.getByRole('button', { name: 'Deny next history page' }).click(); await page.getByRole('button', { name: 'Discover earlier participants' }).click();
  await expect(page.getByRole('alert')).toContainText('History access was denied'); await expect(page.getByText('1 participant found', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Allow history again' }).click(); await page.getByRole('button', { name: 'Pause history page' }).click();
  await page.getByRole('button', { name: 'Continue participant discovery' }).click(); await expect(page.getByRole('status')).toContainText('Discovering');
  await page.getByRole('button', { name: 'Stop participant discovery' }).click(); await expect(page.getByRole('status')).toContainText('Discovery stopped');
  await page.evaluate(() => (window as any).fixtureReleaseHistory());
  await expect(page.getByRole('status')).toContainText('Discovery stopped'); await expect(page.getByRole('alert')).toHaveCount(0);
  // The SDK request is shared with other readers and may finish. Its ordinary
  // timeline update can reveal authors; it must not resume the cancelled run.
  await expect(page.getByText('3 participants found', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Discovery stopped');
});

test('account A to B to A invalidates a pending discovery and clears its participant search', async ({ page }) => {
  await fixture(page); await page.getByText('1 participant found', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Search thread participants' }).fill('old account query');
  await page.getByRole('button', { name: 'Pause history page' }).click(); await page.getByRole('button', { name: 'Discover earlier participants' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixtureHistory.requests.filter((url: URL) => url.searchParams.get('from')).length)).toBe(1);
  await page.getByRole('button', { name: 'Replace account and return' }).click(); await page.evaluate(() => (window as any).fixtureReleaseHistory());
  await expect(page.getByRole('textbox', { name: 'Search thread participants' })).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.getByRole('status')).toHaveCount(0);
});

test('linked SDK history exposes earlier authors and paginates its oldest cursor before claiming completion', async ({ page }) => {
  await fixture(page); await page.evaluate(() => (window as any).fixtureLinkEarlier());
  await page.getByText('2 participants found', { exact: true }).click();
  await expect(page.getByRole('list', { name: 'Thread participants' })).toContainText('@linked:local');
  await expect(page.getByRole('button', { name: 'Discover earlier participants' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Load 50 earlier replies' })).toBeVisible();
  await expect(page.getByText('The participant list is partial.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Discover earlier participants' }).click();
  await expect(page.getByText('4 participants found', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('beginning');
  await expect(page.getByRole('list', { name: 'Loaded thread replies' })).toContainText('Fixture event');
  await expect(page.getByRole('list', { name: 'Loaded thread replies' })).toContainText('First historical encrypted reply');
  expect(await page.evaluate(() => (window as any).fixtureHistory.requests.filter((url: URL) => url.searchParams.has('from')).map((url: URL) => url.searchParams.get('from')))).toEqual(['linked-older-page']);
});

test('relinking during discovery rejects its late completion while the shared SDK request can finish', async ({ page }) => {
  await fixture(page); await page.getByText('1 participant found', { exact: true }).click();
  await page.getByRole('button', { name: 'Pause history page' }).click(); await page.getByRole('button', { name: 'Discover earlier participants' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixtureHistory.requests.filter((url: URL) => url.searchParams.has('from')).length)).toBe(1);
  await page.evaluate(() => { const w = window as any; w.fixtureLinkEarlier(); w.fixtureReleaseHistory(); });
  await expect(page.getByRole('alert')).toContainText('timeline changed');
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue participant discovery' })).toBeEnabled();
  await expect(page.getByRole('list', { name: 'Loaded thread replies' })).not.toContainText('First historical encrypted reply');
});

test('unsupported native history and loaded-event limits produce explicit unavailable states', async ({ page }) => {
  await fixture(page); await page.getByText('1 participant found', { exact: true }).click();
  await page.evaluate(() => { const w = window as any; w.fixtureHistory.client.supportsThreads = () => false; w.fixtureHistoryListeners.forEach((listener: any) => listener()); });
  await expect(page.getByRole('button', { name: 'Discover earlier participants' })).toBeDisabled();
  await expect(page.getByText('Historical thread discovery is unavailable on this homeserver.')).toBeVisible();
  await page.evaluate(() => { const w = window as any, f = w.fixtureHistory, events = f.room.getThread(f.rootId).events; f.client.supportsThreads = () => true; events.push(...Array(20_001).fill(events[0])); w.fixtureHistoryListeners.forEach((listener: any) => listener()); });
  await expect(page.getByText('Participants unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('20,000');
});
