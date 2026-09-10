import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.route('**/management-sections-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/management-sections.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/management-sections-test');
  await expect(page.getByRole('tablist', { name: 'Server management sections' })).toBeVisible();
}

test('keyboard sections mount only visited editors and retain independent unsaved drafts', async ({ page }) => {
  await fixture(page);
  expect(await page.evaluate(() => (window as any).managementFixture.mounted)).toEqual(['server-a/general']);
  await page.getByRole('textbox', { name: 'general draft', exact: true }).fill('Unsubmitted name');
  await page.getByRole('tab', { name: 'General', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Roles and member permissions', exact: true })).toBeFocused();
  await page.getByRole('textbox', { name: 'roles draft', exact: true }).fill('Unsaved role');
  await page.getByRole('tab', { name: 'Roles and member permissions', exact: true }).focus(); await page.keyboard.press('Home');
  await expect(page.getByRole('textbox', { name: 'general draft', exact: true })).toHaveValue('Unsubmitted name');
  await page.getByRole('tab', { name: 'Roles and member permissions', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'roles draft', exact: true })).toHaveValue('Unsaved role');
  expect(await page.evaluate(() => (window as any).managementFixture.mounted)).toEqual(['server-a/general', 'server-a/roles']);
  expect(await page.evaluate(() => (window as any).managementFixture.unmounted)).toEqual([]);
});

test('inactive visited panels are hidden and cannot receive keyboard or programmatic focus', async ({ page }) => {
  await fixture(page);
  await page.getByRole('tab', { name: 'Roles and member permissions', exact: true }).click();
  const hidden = page.locator('input[aria-label="general draft"]');
  await expect(hidden).toHaveCount(1); await expect(hidden).toBeHidden();
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await hidden.evaluate(input => input.focus()); await expect(hidden).not.toBeFocused();
  await page.getByRole('tab', { name: 'Roles and member permissions', exact: true }).focus(); await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel')).toBeFocused(); await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'roles draft', exact: true })).toBeFocused();
  expect(await page.locator('[data-slot=tabs-content][hidden]').evaluate(element => ({ display: getComputedStyle(element).display, inert: (element as HTMLElement).inert }))).toEqual({ display: 'none', inert: true });
});

for (const [width, height] of [[320, 568], [1280, 720]]) test(`all management sections and controls fit at ${width}x${height}`, async ({ page }) => {
  await page.setViewportSize({ width, height }); await fixture(page);
  const tabs = page.getByRole('tab'); expect(await tabs.count()).toBe(5);
  for (const tab of await tabs.all()) {
    await tab.click();
    const dimensions = await page.getByRole('dialog').evaluate(element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, client: element.clientWidth, scroll: element.scrollWidth,
        outside: [...element.querySelectorAll<HTMLElement>('[role=tab],input,button')].filter(control => control.getClientRects().length).filter(control => { const rect = control.getBoundingClientRect(); return rect.left < box.left || rect.right > box.right || control.scrollWidth > control.clientWidth + 1; }).map(control => control.textContent) };
    });
    expect(dimensions.left).toBeGreaterThanOrEqual(15); expect(dimensions.right).toBeLessThanOrEqual(width - 15);
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1); expect(dimensions.outside).toEqual([]);
    await expect(page.getByRole('tabpanel').getByRole('textbox')).toBeVisible();
  }
  expect(await tabs.evaluateAll(elements => new Set(elements.map(element => Math.round(element.getBoundingClientRect().top))).size)).toBeGreaterThan(1);
});

test('a different parent scope retires every mounted draft and resets lazy section selection', async ({ page }) => {
  await fixture(page);
  await page.getByRole('textbox', { name: 'general draft', exact: true }).fill('Old server name');
  await page.getByRole('tab', { name: 'Roles and member permissions', exact: true }).click();
  await page.getByRole('textbox', { name: 'roles draft', exact: true }).fill('Old server role');
  await page.evaluate(() => (window as any).managementFixture.render('server-b'));
  await expect(page.getByRole('tab', { name: 'General', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: 'general draft', exact: true })).toHaveValue('');
  await expect(page.locator('input[aria-label="roles draft"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).managementFixture.unmounted)).toEqual(['server-a/general', 'server-a/roles']);
  expect(await page.evaluate(() => (window as any).managementFixture.mounted)).toEqual(['server-a/general', 'server-a/roles', 'server-b/general']);
});

test('removing the selected section falls back to an available editor and unmounts its controls', async ({ page }) => {
  await fixture(page); await page.getByRole('tab', { name: 'Roles and member permissions', exact: true }).click();
  await page.evaluate(() => (window as any).managementFixture.render('server-a', 'roles'));
  await expect(page.getByRole('tab', { name: 'General', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('input[aria-label="roles draft"]')).toHaveCount(0);
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
});
