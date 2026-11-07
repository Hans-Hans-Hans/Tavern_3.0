import { expect, type Page } from '@playwright/test';
import ts from 'typescript';
import { readFileSync } from 'node:fs';

// Run the real shared account-data mutation in the browser. Other Matrix startup
// services are outside this fixture; the room/client itself is the actual SDK.
const source = ts.createSourceFile('matrix.ts', readFileSync('lib/matrix.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const mutation = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'mutateMatrixAccountData')!.getText(source);
const boundary = ts.transpileModule("let client=null;const accountQueues=new Map();const notify=()=>window.dmFixture.emit();export const fixtureSetDmClient=c=>{client=c};export const getMatrixClient=()=>client;export const onMatrixUpdate=fn=>{window.dmFixture.listeners.add(fn);return()=>window.dmFixture.listeners.delete(fn)};" + mutation, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
export async function workspaceFixture(page: Page, workspace = false, hash = '') {
  const names = [...readFileSync('lib/matrix.ts', 'utf8').matchAll(/export (?:async )?function (\w+)/g)].map(match => match[1]).filter(name => !['getMatrixClient', 'onMatrixUpdate', 'mutateMatrixAccountData'].includes(name));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: boundary + (workspace ? names.map(name => 'export const ' + name + '=(...args)=>window.matrixBoundary(' + JSON.stringify(name) + ',args);').join('\n') : '') }));
  if (!workspace) {
    await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const accountArtworkOwner=()=>window.dmFixture.account;' }));
    await page.route(url => url.pathname === '/lib/interactions.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const blockUser=(...args)=>window.dmFixture.blockUser(...args);' }));
  }
  await page.route('**/config.json', route => route.fulfill({ json: { homeserverUrl: 'http://127.0.0.1:5173', serverRolePolicy: true, callsEnabled: false } }));
  await page.route('**/dm-requests-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/' + (workspace ? 'dm-workspace' : 'dm-requests') + '.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/dm-requests-test' + hash); await expect(workspace ? page.locator('.profile-button:visible, .mobile-profile:visible') : page.getByRole('button', { name: 'Accept message request' })).toBeVisible({timeout:30000});
}
