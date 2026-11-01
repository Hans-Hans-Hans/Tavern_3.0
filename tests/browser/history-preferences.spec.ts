import { test, expect, type Page } from '@playwright/test';

function account() { return { mode: 'off', setupRequired: false, passphraseConfigured: false, emailReady: false, saves: 0, restores: 0 }; }
async function fixture(page: Page, state: ReturnType<typeof account>, query = '') {
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'const account={};export const accountArtworkOwner=()=>account;export const isManagedAccount=()=>true;' }));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'const client={};export const getMatrixClient=()=>client;' }));
  await page.route('**/fixture-history', async route => {
    const body = route.request().postDataJSON();
    if (body?.mode) { state.mode = body.mode; state.setupRequired = body.mode === 'passphrase' && !state.passphraseConfigured; }
    if (body?.save) { state.saves++; state.mode = 'passphrase'; state.passphraseConfigured = true; state.setupRequired = false; }
    if (body?.restore) state.restores++;
    await route.fulfill({ json: state });
  });
  await page.route(url => url.pathname === '/lib/email-history.ts', route => route.fulfill({ contentType: 'text/javascript', body: `
    const update=async body=>{const r=await fetch('/fixture-history',body?{method:'POST',body:JSON.stringify(body)}:undefined);return r.json();};
    export const emailHistoryStatus=()=>update();
    export const setHistoryRecoveryMode=mode=>update({mode});
    export const prepareCurrentHistoryBackup=async()=>{};
    export const enablePassphraseHistory=()=>update({save:true});
    export const recoverPassphraseHistory=()=>update({restore:true});` }));
  await page.route('**/history-preferences-test*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id='root'></div><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/tests/browser/fixtures/history-preferences.tsx');</script></body></html>` }));
  await page.goto('/history-preferences-test' + query);
}

test('account setup needs matching passphrases, works without email, and follows a fresh browser', async ({ page, browser }) => {
  const state = account(); state.setupRequired = true;
  await fixture(page, state, '?automatic&known');
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible({ timeout: 15000 });
  await dialog.getByLabel('History passphrase', { exact: true }).fill('A separate history secret');
  await dialog.getByLabel('Confirm history passphrase').fill('Different history secret');
  await dialog.getByRole('button', { name: 'Save history passphrase' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The history passphrases do not match.');
  expect(state.saves).toBe(0);
  await dialog.getByLabel('Confirm history passphrase').fill('A separate history secret');
  await dialog.getByRole('button', { name: 'Save history passphrase' }).click();
  await expect(dialog).toHaveCount(0); expect(state.saves).toBe(1);
  const context = await browser.newContext();
  try {
    const second = await context.newPage(); await fixture(second, state, '?automatic');
    await expect(second.getByRole('dialog')).toBeVisible();
    await expect(second.getByRole('heading', { name: 'Unlock history with your passphrase' })).toBeVisible();
    await second.getByLabel('History passphrase', { exact: true }).fill('A separate history secret');
    await second.getByRole('button', { name: 'Unlock history', exact: true }).click();
    await expect(second.getByRole('dialog')).toHaveCount(0); expect(state.restores).toBe(1);
  } finally { await context.close(); }
});

test('off is a saved account preference, not a browser-only dismissal', async ({ page, browser }) => {
  const state = account(); state.mode = 'passphrase'; state.passphraseConfigured = true;
  await fixture(page, state, '?known');
  await page.getByLabel('History recovery method').selectOption('off');
  await expect(page.getByRole('status')).toHaveText('History recovery preference saved.');
  const context = await browser.newContext();
  try {
    const second = await context.newPage(); await fixture(second, state, '?automatic');
    await expect(second.getByRole('dialog')).toHaveCount(0);
    expect(state.mode).toBe('off'); expect(state.passphraseConfigured).toBe(true);
  } finally { await context.close(); }
});

test('a device without older keys must acknowledge the limits of protecting available keys', async ({ page }) => {
  const state = account(); state.mode = 'passphrase'; state.setupRequired = true;
  await fixture(page, state);
  const save = page.getByRole('button', { name: 'Save history passphrase' });
  await expect(save).toBeDisabled();
  await page.getByLabel('History passphrase', { exact: true }).fill('A separate history secret');
  await page.getByLabel('Confirm history passphrase').fill('A separate history secret');
  await page.getByRole('checkbox').check(); await save.click();
  await expect(page.getByRole('status')).toContainText('Passphrase recovery saved');
  expect(state.saves).toBe(1);
});
