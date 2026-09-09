import { test, expect } from '@playwright/test';
async function managed(page: any, bootstrapRequired = false) {
  await page.route('**/api/auth/config', (route:any) => route.fulfill({json:{bootstrapRequired,smtpConfigured:true,instance:{name:'Tavern Test'}}}));
  await page.route('**/api/auth/session', (route:any) => route.fulfill({status:401,json:{error:'Sign in first'}}));
}
test('managed sign-in shows actionable errors and never stores passwords', async ({page})=>{
  await managed(page);await page.route('**/api/auth/login',route=>route.fulfill({status:401,json:{error:'The username or password is incorrect.'}}));
  await page.goto('/');await page.getByLabel('Username or email').fill('alice');await page.getByLabel('Password',{exact:true}).fill('not-a-real-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('The username or password is incorrect.');
  expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('not-a-real-password');
});
test('MFA is a required second step and supports recovery codes',async({page})=>{
  await managed(page);await page.route('**/api/auth/login',route=>route.fulfill({json:{mfaRequired:true,challengeId:'test-challenge',methods:['totp','recovery']}}));
  await page.route('**/api/auth/mfa',route=>route.fulfill({status:400,json:{error:'The verification code is incorrect.'}}));
  await page.goto('/');await page.getByLabel('Username or email').fill('alice');await page.getByLabel('Password',{exact:true}).fill('not-a-real-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Verify your identity'})).toBeVisible();await page.getByLabel('Verification method').selectOption('recovery');await page.getByLabel('Recovery code',{exact:true}).fill('invalid-code');await page.getByRole('button',{name:'Verify and continue'}).click();await expect(page.getByRole('alert')).toContainText('incorrect');
});
test('bootstrap requires verified email and fits mobile viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});await managed(page,true);await page.route('**/api/auth/bootstrap/start',route=>route.fulfill({json:{challengeId:'bootstrap-test'}}));
  await page.goto('/');await expect(page.getByRole('heading',{name:'Administrator setup'})).toBeVisible();
  await page.getByLabel('Administrator username').fill('owner');await page.getByLabel('Display name',{exact:true}).fill('Owner');await page.getByLabel('Email',{exact:true}).fill('owner@example.test');await page.getByLabel('New password',{exact:true}).fill('strong-test-password');await page.getByLabel('Confirm password').fill('strong-test-password');await page.getByRole('button',{name:'Send verification code'}).click();
  await expect(page.getByLabel('Verification code')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('account-service outage fails closed instead of showing legacy login',async({page})=>{
  await page.route('**/api/auth/config',route=>route.fulfill({status:502,json:{error:'Temporarily unavailable'}}));await page.goto('/');await expect(page.getByRole('heading',{name:'Unable to connect'})).toBeVisible();await expect(page.getByRole('button',{name:'Connect homeserver'})).toHaveCount(0);
});
