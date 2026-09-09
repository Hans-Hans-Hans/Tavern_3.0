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
  await expect(page.getByRole('button', { name: 'Tavern home', exact: true })).toBeVisible({ timeout: 15000 });
}
