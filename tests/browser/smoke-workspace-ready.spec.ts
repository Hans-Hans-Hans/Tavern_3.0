import { test, expect } from '@playwright/test';
import { dismissOptionalOnboarding } from '../../scripts/smoke-workspace-ready.mjs';

const shell = '<main aria-hidden="true"><button>Tavern home</button></main><button id="finish">Finish later</button>';

test('native smoke dismisses persistent onboarding using the visible control', async ({ page }) => {
  await page.setContent(shell);
  await page.evaluate(() => document.getElementById('finish')!.onclick = () => {
    document.getElementById('finish')!.remove(); document.querySelector('main')!.removeAttribute('aria-hidden');
  });
  await dismissOptionalOnboarding(page);
  await expect(page.getByRole('button', { name: 'Tavern home', exact: true })).toBeVisible();
});

test('native smoke accepts onboarding that disappears during click stability checks', async ({ page }) => {
  await page.setContent('<style>@keyframes shift { from {transform:translateX(0)} to {transform:translateX(50px)} } #finish {animation:shift .3s infinite alternate}</style>' + shell);
  await page.evaluate(() => {
    setTimeout(() => { document.getElementById('finish')!.remove(); document.querySelector('main')!.removeAttribute('aria-hidden'); }, 200);
  });
  await dismissOptionalOnboarding(page);
  await expect(page.getByRole('button', { name: 'Tavern home', exact: true })).toBeVisible();
});

test('native smoke accepts an already restored workspace without onboarding', async ({ page }) => {
  await page.setContent('<button>Tavern home</button>');
  await dismissOptionalOnboarding(page);
});

test('native smoke still fails when onboarding remains unusable', async ({ page }) => {
  await page.setContent(shell.replace('id="finish"', 'id="finish" disabled'));
  await expect(dismissOptionalOnboarding(page)).rejects.toThrow(/Timeout/);
  await expect(page.getByRole('button', { name: 'Finish later', exact: true })).toBeVisible();
});
