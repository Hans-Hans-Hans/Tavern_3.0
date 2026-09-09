import { test, expect } from '@playwright/test';

test('invitation preference loads before edits and failed save preserves the last saved preference', async ({ page }) => {
  let mode = 'contacts', fail = true;
  await page.route('**/api/social/invitation-privacy', async route => {
    if (route.request().method() === 'PUT') {
      if (fail) return route.fulfill({ status: 502, json: { error: 'Homeserver unavailable' } });
      mode = route.request().postDataJSON().invitations;
    }
    return route.fulfill({ json: { invitations: mode } });
  });
  await page.route('**/invitation-privacy-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/tests/browser/fixtures/invitation-privacy.tsx');</script></body></html>` }));
  await page.goto('/invitation-privacy-test');
  await expect(page.getByRole('combobox', { name: 'Who can invite you?' })).toHaveValue('contacts');
  await expect(page.getByRole('button', { name: 'Save invitation privacy' })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Who can invite you?' }).selectOption('nobody');
  await page.getByRole('button', { name: 'Save invitation privacy' }).click();
  await expect(page.getByRole('alert')).toHaveText('Homeserver unavailable');
  await expect(page.getByRole('button', { name: 'Save invitation privacy' })).toBeEnabled();
  expect(mode).toBe('contacts');
  fail = false; await page.getByRole('button', { name: 'Save invitation privacy' }).click();
  await expect(page.getByRole('status')).toHaveText('Conversation invitation privacy saved.');
  expect(mode).toBe('nobody');
});
