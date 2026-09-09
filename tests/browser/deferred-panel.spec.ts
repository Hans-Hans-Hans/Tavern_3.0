import { expect, test } from '@playwright/test';

test('an optional panel load failure stays inside its dialog and retry leaves conversation state intact',async({page})=>{
  await page.route('**/deferred-panel-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/deferred-panel.tsx")).mountFixture();</script></body></html>'}));
  await page.goto('/deferred-panel-test');
  const draft=page.getByRole('textbox',{name:'Conversation draft',exact:true});
  await draft.fill('Keep this draft');
  await page.getByRole('button',{name:'Open optional settings',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Optional settings could not open');
  await page.getByRole('button',{name:'Retry optional settings',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Optional value',exact:true})).toHaveValue('Available again');
  await page.keyboard.press('Escape');
  await expect(draft).toHaveValue('Keep this draft');
});
