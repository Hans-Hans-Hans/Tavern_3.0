import { test, expect, type Page } from '@playwright/test';

function account() { return { mode: 'off', methods: [] as string[], configured: false, setupRequired: false, passphraseConfigured: false, emailReady: false, authenticatorReady: true, factorConfigured: {totp:false,email:false}, factorSaves: [] as string[], factorRestores: [] as string[], saves: 0, restores: 0 }; }
async function fixture(page: Page, state: ReturnType<typeof account>, query = '') {
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'const account={};export const accountArtworkOwner=()=>account;export const isManagedAccount=()=>true;' }));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'const client={};export const getMatrixClient=()=>client;' }));
  await page.route('**/fixture-history', async route => {
    const body = route.request().postDataJSON();
    if (body?.mode) { state.mode = body.mode; state.methods = body.mode === 'off' ? [] : [body.mode]; state.setupRequired = body.mode === 'passphrase' && !state.passphraseConfigured; }
    if (body?.methods) { state.methods = body.methods; state.mode = body.methods[0] || 'off'; state.setupRequired = state.methods.includes('passphrase') && !state.passphraseConfigured; }
    if (body?.save) { state.saves++; state.mode = 'passphrase'; if(!state.methods.includes('passphrase'))state.methods.push('passphrase'); state.passphraseConfigured = true; state.setupRequired = false; }
    if (body?.restore) state.restores++;
    if (body?.factorSave) { state.factorSaves.push(body.factorSave); state.factorConfigured[body.factorSave as 'totp'|'email']=true; }
    if (body?.factorRestore) state.factorRestores.push(body.factorRestore);
    await route.fulfill({ json: state });
  });
  await page.route(url => url.pathname === '/lib/email-history.ts', route => route.fulfill({ contentType: 'text/javascript', body: `
    const update=async body=>{const r=await fetch('/fixture-history',body?{method:'POST',body:JSON.stringify(body)}:undefined);return r.json();};
    export const emailHistoryStatus=()=>update();
    export const setHistoryRecoveryMode=mode=>update({mode});
    export const setHistoryRecoveryMethods=methods=>update({methods});
    export const startFactorHistory=async()=> 'challenge';
    export const hasHistoryLogin=()=>false;
    export const startEmailHistory=async()=> 'email-challenge';
    export const autoStartEmailHistory=startEmailHistory;
    export const enableEmailHistory=async()=>{};
    export const protectCurrentHistory=async()=>{};
    export const recoverEmailHistory=(challenge,code)=>{if(code!=='123456')throw Error('Invalid code');return update({restore:true});};
    export const enableFactorHistory=(method,challenge,code)=>{if(code!=='123456')throw Error('Invalid code');return update({factorSave:method});};
    export const recoverFactorHistory=(method,challenge,code)=>{if(code!=='123456')throw Error('Invalid code');return update({factorRestore:method});};
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

test('authenticator setup offers a disabled existing passphrase and continues setup after recovery', async ({page})=>{
  const state=account();state.mode='totp';state.methods=['totp'];state.setupRequired=true;state.passphraseConfigured=true;
  await fixture(page,state,'?automatic');
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  const factor=dialog.getByRole('region',{name:'Authenticator app history recovery'});
  await expect(factor.getByLabel('Current account password')).toHaveCount(0);
  await dialog.getByRole('button',{name:'Use existing history passphrase',exact:true}).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('History passphrase',{exact:true}).fill('Original history passphrase');
  await dialog.getByRole('button',{name:'Unlock history',exact:true}).click();
  await expect(factor.getByLabel('Current account password')).toBeVisible();
  await factor.getByLabel('Current account password').fill('Account password');
  await factor.getByRole('button',{name:'Use authenticator code'}).click();
  await factor.getByLabel('Authenticator app verification code').fill('123456');
  await factor.getByRole('button',{name:'Save authenticator app recovery'}).click();
  await expect(dialog).toHaveCount(0);
  expect(state.restores).toBe(1);expect(state.factorSaves).toEqual(['totp']);
  expect(state.methods).toEqual(['totp','passphrase']);
});

test('blocked authenticator setup exposes existing legacy email recovery and resumes after its code', async ({page})=>{
  const state=account();state.mode='totp';state.methods=['totp'];state.setupRequired=true;state.configured=true;state.emailReady=true;
  await fixture(page,state,'?automatic');
  await page.getByRole('button',{name:'Use existing email recovery',exact:true}).click();
  await page.getByRole('button',{name:'Unlock with email code',exact:true}).click();
  const email=page.getByRole('dialog').last();
  await email.getByLabel('Password used to protect history').fill('Original account password');
  await email.getByLabel('Email verification code').fill('123456');
  await email.getByRole('button',{name:'Unlock history',exact:true}).click();
  const factor=page.getByRole('region',{name:'Authenticator app history recovery'});
  await expect(factor.getByLabel('Current account password')).toBeVisible();
  await expect(factor.getByRole('button',{name:'Use authenticator code'})).toBeEnabled();
  expect(state.restores).toBe(1);
});

test('off is a saved account preference, not a browser-only dismissal', async ({ page, browser }) => {
  const state = account(); state.mode = 'passphrase'; state.methods=['passphrase']; state.passphraseConfigured = true;
  await fixture(page, state, '?known');
  await page.getByRole('checkbox', {name:'Use history passphrase',exact:true}).uncheck();
  await expect(page.getByRole('status')).toHaveText('History recovery preference saved.');
  const context = await browser.newContext();
  try {
    const second = await context.newPage(); await fixture(second, state, '?automatic');
    await expect(second.getByRole('dialog')).toHaveCount(0);
    expect(state.mode).toBe('off'); expect(state.passphraseConfigured).toBe(true);
  } finally { await context.close(); }
});

test('a device without older keys must acknowledge the limits of protecting available keys', async ({ page }) => {
  const state = account(); state.mode = 'passphrase'; state.methods=['passphrase']; state.setupRequired = true;
  await fixture(page, state);
  const save = page.getByRole('button', { name: 'Save history passphrase' });
  await expect(save).toBeDisabled();
  await page.getByLabel('History passphrase', { exact: true }).fill('A separate history secret');
  await page.getByLabel('Confirm history passphrase').fill('A separate history secret');
  await page.getByRole('checkbox', {name:/Protect keys available/}).check(); await save.click();
  await expect(page.getByRole('status')).toContainText('Passphrase recovery saved');
  expect(state.saves).toBe(1);
});

test('passphrase, authenticator and email coexist and either code unlocks on a fresh device', async ({page,browser}) => {
  const state=account();state.emailReady=true;state.mode='passphrase';state.methods=['passphrase'];state.passphraseConfigured=true;
  await fixture(page,state,'?known');
  await page.getByRole('checkbox',{name:'Authenticator app',exact:true}).check();
  await expect(page.getByRole('region',{name:'Authenticator app history recovery'})).toBeVisible();
  await page.getByRole('checkbox',{name:'Email code',exact:true}).check();
  for(const method of ['totp','email'] as const){
    const name=method==='totp'?'Authenticator app':'Email code';
    const region=page.getByRole('region',{name:`${name} history recovery`});
    await region.getByLabel('Current account password').fill('Current password');
    await region.getByRole('button',{name:method==='totp'?'Use authenticator code':'Send history verification code'}).click();
    await region.getByLabel(`${name} verification code`).fill('123456');
    await region.getByRole('button',{name:`Save ${name.toLowerCase()} recovery`}).click();
    await expect(region.getByRole('status')).toContainText('recovery saved');
  }
  expect(state.methods).toEqual(['passphrase','totp','email']);expect(state.factorSaves).toEqual(['totp','email']);
  const context=await browser.newContext({viewport:{width:375,height:700}});
  try{
    const second=await context.newPage();await fixture(second,state,'?automatic');
    const dialog=second.getByRole('dialog');await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
    const authenticator=dialog.getByRole('region',{name:'Authenticator app history recovery'});
    await authenticator.getByRole('button',{name:'Use authenticator code'}).click();
    await authenticator.getByLabel('Authenticator app verification code').fill('000000');
    await authenticator.getByRole('button',{name:'Unlock history with authenticator app'}).click();
    await expect(authenticator.getByRole('alert')).toHaveText('Invalid code');
    await authenticator.getByLabel('Authenticator app verification code').fill('123456');
    await authenticator.getByRole('button',{name:'Unlock history with authenticator app'}).click();
    await expect(dialog).toHaveCount(0);
    await second.reload();await expect(second.getByRole('dialog')).toBeVisible();
    const email=second.getByRole('region',{name:'Email code history recovery'});
    await email.getByRole('button',{name:'Send history verification code'}).click();
    await email.getByLabel('Email code verification code').fill('123456');
    await email.getByRole('button',{name:'Unlock history with email code'}).click();
    await expect(second.getByRole('dialog')).toHaveCount(0);
    expect(state.factorRestores).toEqual(['totp','email']);expect(state.restores).toBe(0);
  }finally{await context.close();}
});
