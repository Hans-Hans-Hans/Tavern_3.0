import { errors, expect } from '@playwright/test';

// Stored account data may finish loading between observing onboarding and
// clicking it. Only accept a disappearing control when the workspace is ready.
export async function dismissOptionalOnboarding(page) {
  const finish = page.getByRole('button', { name: 'Finish later', exact: true });
  if (await finish.isVisible()) {
    try { await finish.click({ timeout: 1000 }); }
    catch (error) {
      if (!(error instanceof errors.TimeoutError) || await finish.isVisible()) throw error;
    }
  }
  await expect(finish).toBeHidden({ timeout: 15000 });
  // A new-device recovery dialog intentionally aria-hides the workspace.
  // Leave it open for the email acceptance flow to verify and complete.
  try {
    await expect.poll(async () =>
      await page.getByRole('button', { name: 'Tavern home', exact: true }).isVisible()
      || await page.getByRole('dialog', { name: 'Unlock your message history', exact: true }).isVisible(),
    { timeout: 15000 }).toBe(true);
  } catch {
    const diagnostic = await page.evaluate(() => {
      const home = document.querySelector('button[aria-label="Tavern home"]'), rect = home?.getBoundingClientRect();
      return {home:!!home,width:rect ? Math.round(rect.width) : null,height:rect ? Math.round(rect.height) : null,
        ariaHidden:!!home?.closest('[aria-hidden="true"]'),hidden:!!home?.closest('[hidden]'),
        dialogs:document.querySelectorAll('[role="dialog"]').length,
        rail:!!document.querySelector('.workspace-rail')};
    }).catch(()=>null);
    throw new Error('Native workspace readiness failed. Bounded layout state: '+JSON.stringify(diagnostic));
  }
}
