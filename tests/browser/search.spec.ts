import { test } from '@playwright/test';
import { checkSearchStorage } from '../search-browser.mjs';
test('encrypted search persists in real IndexedDB, reconciles edits, and enforces room/user filtering', async ({ page }) => { await checkSearchStorage(page); });
