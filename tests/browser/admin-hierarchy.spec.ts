import { test, expect, type Page } from '@playwright/test';
const ROOT = '!space:local', CHILD = '!child:local', stamp = 'a'.repeat(64);
function metadata(id: string, name = id === ROOT ? 'Native server' : 'Native channel', server = id === ROOT) {
  return { roomId: id, status: 'available', name, kind: server ? 'server' : 'conversation', roomVersion: '12', creators: ['@creator:local'],
    creatorAuthority: 'inherent', createdAt: 1700000000000, joinedMembers: 2, encryption: 'm.megolm.v1.aes-sha2', joinRule: 'invite', archived: null, replacementRoomId: null };
}
function link(id: string, direction = 'child', name?: string, server = false) { return { roomId: id, direction, status: 'confirmed', canonical: true, room: metadata(id, name, server) }; }
function hierarchy(id: string, links: any[] = id === ROOT ? [link(CHILD)] : [link(ROOT, 'parent', 'Native server', true)], extra: any = {}) {
  return { room: metadata(id), links, revision: stamp, nextOffset: null, omittedLinks: 0, truncated: false, checkedAt: 1700000000000, ...extra };
}
async function fixture(page: Page, full = false) {
  let blocked = false; const mutations: any[] = [], reads: string[] = [];
  await page.route('**/api/admin/rooms?*', route => route.fulfill({ json: { rooms: [{ room_id: ROOT, name: 'Native server', room_type: 'm.space', joined_members: 2 }, { room_id: CHILD, name: 'Native channel', joined_members: 2 }], total_rooms: 2 } }));
  await page.route('**/api/admin/rooms/*', route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    return route.fulfill({ json: { room: { room_id: id, name: id === ROOT ? 'Native server' : 'Native channel', encryption: 'm.megolm.v1.aes-sha2' }, members: { members: ['@creator:local', '@member:local'], total: 2, next: null }, blocked } });
  });
  await page.route('**/api/admin/rooms/*/block', route => { const body = route.request().postDataJSON(); mutations.push(body); blocked = body.block; return route.fulfill({ json: { block: blocked } }); });
  await page.route('**/api/admin/rooms/*/hierarchy?*', route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!); reads.push(id);
    return route.fulfill({ json: hierarchy(id) });
  });
  if (full) {
    await page.route('**/api/auth/config', route => route.fulfill({ json: { bootstrapRequired: false, smtpConfigured: true, instance: { name: 'Tavern' } } }));
    await page.route('**/api/auth/session', route => route.fulfill({ json: { userId: '@owner:local', deviceId: 'ADMIN-A', baseUrl: '/api/matrix', admin: true } }));
    await page.route('**/api/system/status', route => route.fulfill({ json: { maintenance: { enabled: false }, announcements: [] } }));
    await page.route('**/api/system/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
    await page.route('**/api/admin/overview', route => route.fulfill({ json: { users: 2, rooms: 2, sessions: 1 } }));
    await page.goto('/admin'); await page.getByRole('button', { name: 'Rooms', exact: true }).click();
  } else {
    await page.route('**/admin-rooms-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/tests/browser/fixtures/admin-rooms.tsx');</script></body></html>` }));
    await page.goto('/admin-rooms-fixture');
  }
  await expect(page.getByRole('button', { name: 'Inspect', exact: true })).toHaveCount(2);
  return { mutations, reads };
}
async function inspect(page: Page) {
  await page.getByRole('button', { name: 'Inspect', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Server and channel hierarchy' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand Native channel', exact: true })).toBeVisible();
}

test('administrator Rooms navigation opens actual native hierarchy and preserves exact block/unblock confirmation', async ({ page }) => {
  const f = await fixture(page, true); await inspect(page);
  await expect(page.getByText('@creator:local (inherent room authority in version 12)', { exact: true })).toBeVisible();
  await expect(page.getByText('Unavailable: this inspector reads room metadata only.', { exact: true })).toBeVisible();
  expect(f.reads).toEqual([ROOT]);
  await page.getByRole('button', { name: 'Expand Native channel', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByText('Already on this path. Cycle or reciprocal reference; expansion stopped.', { exact: true })).toBeVisible();
  expect(f.reads).toEqual([ROOT, CHILD]);
  await expect(page.getByRole('button', { name: 'Block new joins', exact: true })).toBeDisabled();
  await page.getByLabel('Type the room ID to confirm').fill(ROOT); await page.getByRole('button', { name: 'Block new joins', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unblock new joins', exact: true })).toBeVisible();
  await page.getByLabel('Type the room ID to confirm').fill(ROOT); await page.getByRole('button', { name: 'Unblock new joins', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Block new joins', exact: true })).toBeVisible();
  expect(f.mutations).toEqual([{ block: true, confirmation: ROOT }, { block: false, confirmation: ROOT }]);
  await page.getByText('Members (2)', { exact: true }).click(); await expect(page.getByText('@member:local', { exact: true })).toBeVisible();
});

test('current revision paging reports conflict and unavailable links without inventing accessible children', async ({ page }) => {
  await fixture(page); const queries: URLSearchParams[] = [];
  await page.route('**/api/admin/rooms/*/hierarchy?*', route => {
    const query = new URL(route.request().url()).searchParams; queries.push(query);
    return query.get('from') === '20' ? route.fulfill({ status: 409, json: { error: 'Room relationships changed. Reload this hierarchy node before continuing.' } }) :
      route.fulfill({ json: hierarchy(ROOT, [{ roomId: '!unavailable:local', direction: 'child', canonical: false, status: 'unavailable', reason: 'Native room state exceeds the inspection byte limit.' }], { nextOffset: 20, omittedLinks: 2 }) });
  });
  await page.getByRole('button', { name: 'Inspect', exact: true }).first().click();
  await expect(page.getByText('Native room state exceeds the inspection byte limit.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Expand !unavailable/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more relationships for Native server', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Room relationships changed');
  expect(queries.at(-1)?.get('revision')).toBe(stamp);
  await page.getByRole('button', { name: 'Reload Native server', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('late room details and hierarchy pages cannot replace a newly selected room', async ({ page }) => {
  await fixture(page); let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/admin/rooms/' + encodeURIComponent(ROOT), async route => { started(); await gate; await route.fulfill({ json: { room: { room_id: ROOT, name: 'STALE ROOM' }, members: { members: [], total: 0, next: null }, blocked: false } }); });
  await page.getByRole('button', { name: 'Inspect', exact: true }).first().click(); await waiting;
  await page.getByRole('button', { name: 'Inspect', exact: true }).last().click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Native channel', exact: true }).first()).toBeVisible();
  release(); await expect(page.getByText('STALE ROOM', { exact: true })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  let releaseHierarchy!: () => void, startHierarchy!: () => void;
  const waitingHierarchy = new Promise<void>(resolve => { startHierarchy = resolve; }), gateHierarchy = new Promise<void>(resolve => { releaseHierarchy = resolve; });
  await page.unroute('**/api/admin/rooms/' + encodeURIComponent(ROOT));
  await page.route('**/api/admin/rooms/*/hierarchy?*', async route => { startHierarchy(); await gateHierarchy; await route.fulfill({ json: hierarchy(ROOT, [link('!stale:local', 'child', 'STALE HIERARCHY')]) }); });
  await page.getByRole('button', { name: 'Inspect', exact: true }).first().click(); await waitingHierarchy;
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click(); releaseHierarchy();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByText('STALE HIERARCHY', { exact: true })).toHaveCount(0);
});

test('account A to B to A invalidates visible and delayed administrator metadata', async ({ page }) => {
  await fixture(page); await inspect(page);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/admin/rooms/*/hierarchy?*', async route => { started(); await gate; await route.fulfill({ json: hierarchy(CHILD, [link('!private:local', 'child', 'OLD ACCOUNT METADATA')]) }); });
  await page.getByRole('button', { name: 'Expand Native channel', exact: true }).click(); await waiting;
  await page.evaluate(() => (window as any).adminRoomFixture.changeOwner()); release();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('alert')).toContainText('Your account changed');
  await expect(page.getByText('OLD ACCOUNT METADATA', { exact: true })).toHaveCount(0); await expect(page.getByText('Native server', { exact: true })).toHaveCount(0);
});

test('reloading a parent drops expanded descendants and their pending results, then permits separate room inspection', async ({ page }) => {
  await fixture(page); await inspect(page);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/admin/rooms/' + encodeURIComponent(CHILD) + '/hierarchy?*', async route => {
    started(); await gate; await route.fulfill({ json: hierarchy(CHILD, [link('!late:local', 'child', 'REMOVED DESCENDANT')]) });
  });
  await page.getByRole('button', { name: 'Expand Native channel', exact: true }).click(); await waiting;
  await page.getByRole('button', { name: 'Reload Native server', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand Native channel', exact: true })).toBeVisible(); release();
  await expect(page.getByText('REMOVED DESCENDANT', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Inspect Native channel', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Native channel', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Server and channel hierarchy' }).getByText(CHILD, { exact: true }).first()).toBeVisible();
});

test('touch navigation respects hierarchy depth and leaves an explicit separate inspection path', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page);
  await page.route('**/api/admin/rooms/*/hierarchy?*', route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
    const depth = id === ROOT ? 0 : Number(id.match(/level(\d+)/)![1]);
    return route.fulfill({ json: hierarchy(id, [link('!level' + (depth + 1) + ':local', 'child', 'Level ' + (depth + 1), true)]) });
  });
  await page.getByRole('button', { name: 'Inspect', exact: true }).first().click();
  for (let level = 1; level < 8; level++) await page.getByRole('button', { name: 'Expand Level ' + level, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand Level 8', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Inspect Level 8', exact: true })).toBeEnabled();
  const width = await page.getByRole('dialog').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
});

test('relationship pagination stops at the bounded display budget', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/admin/rooms/*/hierarchy?*', route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('from'));
    return route.fulfill({ json: hierarchy(ROOT, Array.from({ length: 20 }, (_, index) => link('!node' + (offset + index) + ':local', 'child', 'Node ' + (offset + index))), { nextOffset: offset + 20 }) });
  });
  await page.getByRole('button', { name: 'Inspect', exact: true }).first().click();
  for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
    const more = page.getByRole('button', { name: 'Load more relationships for Native server', exact: true }); await expect(more).toBeEnabled(); await more.click();
    await expect(page.getByRole('button', { name: /^Expand Node / })).toHaveCount(Math.min(99, (pageIndex + 2) * 20));
  }
  await expect(page.getByRole('button', { name: 'Load more relationships for Native server', exact: true })).toBeDisabled();
  await expect(page.getByText('The 100-room display limit was reached. This node is partial. Inspect it separately to continue.', { exact: true })).toBeVisible();
});

test('parent and child edges to the same Space have independent traversal identity and cannot duplicate expanded subtrees', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/admin/rooms/*/hierarchy?*', route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
    const depth = id === ROOT ? 0 : Number(id.match(/level(\d+)/)![1]);
    const next = '!level' + (depth + 1) + ':local', name = 'Level ' + (depth + 1);
    return route.fulfill({ json: hierarchy(id, [link(next, 'parent', name, true), link(next, 'child', name, true)]) });
  });
  await page.getByRole('button', { name: 'Inspect', exact: true }).first().click();
  for (let level = 1; level < 8; level++) await page.getByRole('button', { name: 'Expand Level ' + level, exact: true }).first().click();
  await expect(page.locator('.admin-hierarchy-links > li')).toHaveCount(16);
  await expect(page.locator('.admin-hierarchy-node')).toHaveCount(8);
  await expect(page.getByRole('button', { name: 'Expand Level 8', exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Expand Level 8', exact: true }).first()).toBeDisabled();
  await page.getByRole('button', { name: 'Expand Level 1', exact: true }).click();
  await expect(page.locator('.admin-hierarchy-node')).toHaveCount(9);
  await expect(page.locator('.admin-hierarchy-links > li')).toHaveCount(18);
});
