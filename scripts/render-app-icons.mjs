// Render the existing Tavern SVG without introducing a second icon design.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const svg = await readFile('public/tavern-icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  for (const size of [192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent('<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{width:100%;height:100%;display:block}</style>' + svg);
    await page.screenshot({ path: `public/tavern-icon-${size}.png`, omitBackground: true });
  }
  await page.setContent('<style>html,body{margin:0;width:100%;height:100%;background:#303843}body{display:grid;place-items:center}svg{width:76%;height:76%}</style>' + svg);
  await page.screenshot({ path: 'public/tavern-icon-maskable.png' });
} finally { await browser.close(); }
