import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile('tavern.tsx', readFileSync('app/tavern.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const composer = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'Composer')!.getText(source);
const matrixSource = ts.createSourceFile('matrix.ts', readFileSync('lib/matrix.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const api = matrixSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'matrixApi') as ts.FunctionDeclaration;
const send = api.body!.statements.find(node => ts.isIfStatement(node) && node.expression.getText(matrixSource) === "action==='send'")!.getText(matrixSource);
const js = (code: string) => ts.transpileModule(code.replace("import {useState,useEffect,useRef} from 'react';", "const React=window.roleFixture.React,{useState,useEffect,useRef}=React;").replace(/import \{([^}]+)\} from 'lucide-react';/, 'const {$1}=window.roleFixture.icons;'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
const matrix = js(`import {sendMatrixTransaction} from '/lib/send-matrix-transaction.ts';import {readMatrixSendAttempt,rememberMatrixSendAttempt,forgetMatrixSendAttempt,assertMatrixSendAttemptCapacity} from '/lib/matrix-send-attempt.ts';import {attachmentTransaction,validateQueuedAttachments} from '/lib/outbox-attachments.ts';import {expandRoleMentions,checkRoleMentionSize} from '/lib/role-mentions.ts';let client=null;export const getMatrixClient=()=>client=window.roleFixture?.client||null;export const onMatrixUpdate=fn=>{window.roleFixture.listeners.add(fn);return()=>window.roleFixture.listeners.delete(fn)};export const sendMatrixTyping=async()=>{};export const discardMatrixFile=id=>window.roleFixture.pendingFiles.delete(id);export const uploadMatrixFile=async()=>{throw new Error('No upload in this fixture')};const accountArtworkOwner=()=>window.roleFixture.account,notify=()=>window.roleFixture.notify(),safeString=x=>typeof x==='string'?x:'',readServerEmoji=()=>[],serverEmojiHtml=()=>null,roomRequired=id=>getMatrixClient().getRoom(id);export async function matrixApi(action,p){const c=getMatrixClient(),me=c.getUserId(),pendingFiles=window.roleFixture.pendingFiles;${send}}`);
const component = js(`import {messageDrafts,useMessageDraft} from '/app/message-drafts.tsx';import {watchOutbox,outboxOwner,readOutbox,deliverOutboxNow} from '/lib/outbox.ts';import {useState,useEffect,useRef} from 'react';import {FileText,Loader2,X,Plus,Code2,Smile,AtSign,Send,ChevronDown} from 'lucide-react';import {DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuTrigger} from '/components/ui/dropdown-menu.tsx';import {RoleMentionPicker} from '/app/role-mention-picker.tsx';import {getMatrixClient,matrixApi,sendMatrixTyping,discardMatrixFile,uploadMatrixFile} from '/lib/matrix.ts';const api=matrixApi,memoryDrafts=window.roleFixture.drafts,toast={error:message=>window.roleFixture.errors.push(message),success:()=>{}},useTextMedia=()=>({enterToSend:true}),postingRestriction=()=>'',threadReplyRestriction=()=>'',shouldSendOnKey=()=>false,enqueueOutbox=async()=>{};const ScheduleMessage=()=>null,EmojiPicker=()=>null;function IconButton({label,children,...props}){return <button aria-label={label} {...props}>{children}</button>};export ${composer}`);

async function fixture(page: Page) {
  page.on('pageerror', error => console.log('Role fixture:', error.message));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: matrix }));
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const accountArtworkOwner=()=>window.roleFixture.account;' }));
  await page.route(url => url.pathname === '/lib/community.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const serverChannelIds=()=>[];' }));
  await page.route(url => url.pathname === '/role-composer-boundary.js', route => route.fulfill({ contentType: 'application/javascript', body: component }));
  await page.route('**/role-mentions-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/role-mentions.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/role-mentions-test'); await expect(page.getByRole('textbox', { name: 'Message Role test', exact: true })).toBeVisible();
}
async function enable(page: Page) {
  // Duplicate names are deliberately present. The editor fields belong to their
  // own role fieldset; the picker additionally identifies each stable role ID.
  await page.getByRole('button', { name: 'Edit Helpers (mod)', exact: true }).click();
  await page.getByLabel('Allow members to mention this role', { exact: true }).check();
  await page.getByRole('button', { name: 'Save roles and permissions', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).roleFixture.states.get('!server:test').find((event: any) => event.type === 'io.tavern.roles').content.roles.find((role: any) => role.id === 'mod').mentionable)).toBe(true);
}
test('hierarchy-gated role editor enables a picker selection that sends native current recipient mentions', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Mention a member', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /Mention role/ })).toHaveCount(0); await page.keyboard.press('Escape');
  await enable(page);
  await page.getByRole('button', { name: 'Mention a member', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Mention role Helpers (mod) in Test server', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Role test', exact: true })).toHaveValue('[@Helpers](tavern-role:%21server%3Atest/mod) ');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Role test', exact: true })).toHaveValue('');
  const sent = await page.evaluate(() => (window as any).roleFixture.writes.find((write: any) => write.action === 'send'));
  expect(sent.content['m.mentions'].user_ids.sort()).toEqual(['@author:test', '@member:test']); expect(sent.roomId).toBe('!source:test');
});
test('revoked role after selection keeps the actual composer draft and sends nothing', async ({ page }) => {
  await fixture(page); await enable(page); await page.getByRole('button', { name: 'Mention a member', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Mention role Helpers (mod) in Test server', exact: true }).click();
  await page.evaluate(() => { const f = (window as any).roleFixture; f.states.get(f.serverId).find((event: any) => event.type === 'io.tavern.roles').content.roles.find((role: any) => role.id === 'mod').mentionable = false; f.notify(); });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).roleFixture.errors.join(' '))).toContain('no longer mentionable');
  await expect(page.getByRole('textbox', { name: 'Message Role test', exact: true })).toHaveValue('[@Helpers](tavern-role:%21server%3Atest/mod) ');
  expect(await page.evaluate(() => (window as any).roleFixture.writes.filter((write: any) => write.action === 'send'))).toEqual([]);
});
test('account replacement while members load cannot send the previous composer role selection', async ({ page }) => {
  await fixture(page); await enable(page); await page.getByRole('button', { name: 'Mention a member', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Mention role Helpers (mod) in Test server', exact: true }).click();
  await page.evaluate(() => { const f = (window as any).roleFixture; f.client.getRoom(f.sourceId).loadMembersIfNeeded = () => new Promise<void>(resolve => { f.release = resolve; }); });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).roleFixture.release === 'function');
  await page.evaluate(() => { const f = (window as any).roleFixture; f.account = {}; f.release(); });
  await expect(page.getByRole('textbox', { name: 'Message Role test', exact: true })).toHaveValue('');
  expect(await page.evaluate(() => (window as any).roleFixture.errors)).toEqual([]);
  expect(await page.evaluate(() => (window as any).roleFixture.writes.filter((write: any) => write.action === 'send'))).toEqual([]);
});

test('an already-open picker rechecks the role, API owner and same-client actor before inserting', async ({ page }) => {
  for (const changed of ['role', 'owner', 'actor']) {
    await fixture(page); await enable(page); await page.getByRole('button', { name: 'Mention a member', exact: true }).click();
    await page.evaluate(changed => {
      const f = (window as any).roleFixture;
      if (changed === 'role') f.states.get(f.serverId).find((event: any) => event.type === 'io.tavern.roles').content.roles.find((role: any) => role.id === 'mod').mentionable = false;
      else if (changed === 'owner') f.account = {};
      else f.client.getUserId = () => '@replacement:test';
      // Deliberately omit the SDK update so the existing menu callback is stale.
    }, changed);
    await page.getByRole('menuitem', { name: 'Mention role Helpers (mod) in Test server', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message Role test', exact: true })).toHaveValue('');
  }
});

test('ambiguous escaped role example retains the actual composer draft without sending', async ({ page }) => {
  await fixture(page);
  const body = '\\[@everyone](tavern-role:%21server%3Atest/mod)';
  await page.getByRole('textbox', { name: 'Message Role test', exact: true }).fill(body);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).roleFixture.errors.join(' '))).toContain('role example is ambiguous');
  await expect(page.getByRole('textbox', { name: 'Message Role test', exact: true })).toHaveValue(body);
  expect(await page.evaluate(() => (window as any).roleFixture.writes.filter((write: any) => write.action === 'send'))).toEqual([]);
});
