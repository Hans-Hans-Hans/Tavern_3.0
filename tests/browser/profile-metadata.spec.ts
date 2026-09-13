import { test, expect } from '@playwright/test';

test('quick profiles avoid account metadata requests and full profiles display authoritative or unavailable dates', async ({ page }) => {
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: "export const getMatrixClient=()=>({getUserId:()=> '@self:local'});" }));
  await page.route(url => url.pathname === '/lib/community.ts', route => route.fulfill({ contentType: 'text/javascript', body: "export const readMemberProfile=()=>({name:'Peer',avatar:'',bio:'Biography',status:'',accent:''});export const readMemberProfileContext=()=>({mutualServers:[]});" }));
  await page.route(url => url.pathname === '/app/community-settings.tsx', route => route.fulfill({ contentType: 'text/javascript', body: 'export const CommunityImage=()=>null;' }));
  await page.route(url => url.pathname === '/app/role-identity.tsx', route => route.fulfill({ contentType: 'text/javascript', body: 'export const ServerRoleBadges=()=>null;export const ServerRoleName=({children})=>children;' }));
  const requests: URL[] = [];
  await page.route('**/api/profiles/**', route => { const url = new URL(route.request().url()); requests.push(url); return route.fulfill({ json: { createdAt: url.pathname.includes('remote') ? null : 1700000000000 } }); });
  await page.route('**/profile-metadata-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import('/tests/browser/fixtures/profile-metadata.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/profile-metadata-test'); await page.getByRole('button', { name: 'Open quick profile' }).click();
  await expect(page.getByRole('button', { name: 'Full profile', exact: true })).toBeVisible(); expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Full profile', exact: true }).click();
  await expect(page.locator('time')).toHaveAttribute('datetime', '2023-11-14T22:13:20.000Z');
  expect(requests).toHaveLength(1); expect(requests[0].searchParams.get('roomId')).toBe('!shared:local');
  await page.getByRole('button', { name: 'Show remote profile' }).click();
  await expect(page.getByText('Account created: Unavailable', { exact: true })).toBeVisible();
  await expect(page.locator('time')).toHaveCount(0);
});
