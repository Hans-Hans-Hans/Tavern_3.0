import { expect, test, type Page } from '@playwright/test';
import ts from 'typescript';
import { readFileSync } from 'node:fs';

const tavern = ts.createSourceFile('tavern.tsx', readFileSync('app/tavern.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let expression = '', previewExpression = '';
function find(node: ts.Node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tavern) === 'RichMessage' && node.attributes.getText(tavern).includes('m.body')) expression = node.getText(tavern);
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tavern) === 'LinkPreviews' && node.attributes.getText(tavern).includes('m.body')) previewExpression = node.getText(tavern);
  ts.forEachChild(node, find);
}
find(tavern);
if (!expression || !previewExpression) throw new Error('The actual Tavern message formatting/preview expression is missing.');
const actualExpression = ts.transpileModule('import React from "react";import {RichMessage} from "/app/rich-message.tsx";import {LinkPreviews} from "/app/link-previews.tsx";import {ServerEmojiText} from "/app/server-emoji.tsx";export function MessageExpression({text}){const m={body:text};const messageServer={id:"!guild:test"};return <>' + expression + '{window.previewMarkdown&&' + previewExpression + '}</>;}', { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText.replaceAll('"react/jsx-runtime"', '"/node_modules/.vite/deps/react_jsx-runtime.js"').replaceAll('"react"', '"/node_modules/.vite/deps/react.js"');

async function fixture(page: Page, text: string, search = false, preview = false) {
  await page.addInitScript(({ text, search, preview }) => {
    Object.assign(window, { initialMarkdown: text, searchMarkdown: search, previewMarkdown: preview, copiedMarkdown: [], openedMessages: [], clipboardDenied: false, previewResponses: 0, previewAccount: {} });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
      if ((window as any).clipboardDenied) throw new Error('Clipboard denied');
      (window as any).copiedMarkdown.push(value);
    } } });
  }, { text, search, preview });
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const isManagedAccount=()=>true;export const accountArtworkOwner=()=>window.previewAccount;export const requestApi=async(path,body)=>{const response=await fetch("/api"+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const result=await response.json();window.previewResponses++;return result;};' }));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'const client={getUserId:()=>"@alice:test",getRoom:()=>({currentState:{getStateEvents:()=>({getContent:()=>({emoji:[{name:"cheers",uri:"mxc://test/emoji",creator:"@owner:test"}]})})}}),getRooms:()=>[]};export const getMatrixClient=()=>client;export const onMatrixUpdate=()=>()=>{};export const resolveMatrixMessage=async(roomId,id)=>({id,roomId});' }));
  await page.route(url => url.pathname === '/lib/community.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const cleanMxc=value=>typeof value==="string"&&value.startsWith("mxc://")?value:null;export const cropProfileImage=()=>{};export const uploadProfileImage=()=>{};' }));
  await page.route(url => url.pathname === '/app/community-settings.tsx', route => route.fulfill({ contentType: 'application/javascript', body: 'import React from "/node_modules/.vite/deps/react.js";export const CommunityImage=({name})=>React.createElement("span",{role:"img","aria-label":name},"🍻");' }));
  await page.route(url => url.pathname === '/lib/search-index.ts', route => route.fulfill({ contentType: 'application/javascript', body: 'export const searchMessages=async()=>({hits:[{id:"$result",roomId:"!guild:test",roomName:"Guild",authorName:"Alice",timestamp:1,body:window.initialMarkdown}],cursor:null,indexedCount:1});export const searchIndexStatus=async()=>({indexedCount:1});export const indexRoomHistory=async()=>{};export const clearSearchIndex=async()=>{};' }));
  await page.route('**/markdown-expression', route => route.fulfill({ contentType: 'application/javascript', body: actualExpression }));
  await page.route('**/rich-message-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/rich-message.tsx")).mountFixture((await import("/markdown-expression")).MessageExpression);</script></body></html>' }));
  await page.goto('/rich-message-test');
  await expect(page.getByRole('region', { name: 'Plain rendering' })).toContainText('A normal message');
}

test('actual Tavern expression preserves nested Markdown across custom emoji, lists and escapes', async ({ page }) => {
  await fixture(page, '# Title\n\n**Bold :cheers: and *italic***\n\n- first\n  - nested\n\n3. third\n\n> quote\n> > nested quote\n\n\\*literal\\* and ~~old~~');
  const message = page.getByRole('region', { name: 'Rendered message' });
  await expect(message.getByRole('heading', { name: 'Title', level: 1 })).toBeVisible();
  await expect(message.locator('strong').getByRole('img', { name: 'cheers' })).toBeVisible();
  await expect(message.locator('strong em')).toHaveText('italic');
  await expect(message.locator('ul ul li')).toHaveText('nested');
  await expect(message.locator('ol')).toHaveAttribute('start', '3');
  await expect(message.locator('blockquote blockquote')).toContainText('nested quote');
  await expect(message).toContainText('*literal*'); await expect(message.locator('del')).toHaveText('old');
});

test('hostile HTML and resource markup cannot execute or load remote media', async ({ page }) => {
  const remote: string[] = [];
  page.on('request', request => { if (/tracker\.invalid|evil\.invalid/.test(request.url())) remote.push(request.url()); });
  await fixture(page, '<img src="https://tracker.invalid/pixel" onerror="window.pwned=1">\n<script>window.pwned=2</script>\n<iframe src="https://evil.invalid/"></iframe>\n\n[x](javascript:alert(1)) [x](data:text/html,evil) [x](https://user:pass@evil.invalid) [relative](/api/admin)\n\n![Image](https://tracker.invalid/image.svg) [safe](https://example.org/a_(b))');
  const message = page.getByRole('region', { name: 'Rendered message' });
  await expect(message.locator('img,script,iframe,video,audio,object,embed,style')).toHaveCount(0);
  await expect(message).toContainText('<script>window.pwned=2</script>');
  expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined(); expect(remote).toEqual([]);
  const anchors = await message.locator('a').evaluateAll(nodes => nodes.map(node => ({ href: node.getAttribute('href'), rel: node.getAttribute('rel'), target: node.getAttribute('target'), referrer: node.getAttribute('referrerpolicy') })));
  expect(anchors.length).toBeGreaterThan(0);
  for (const anchor of anchors) { expect(anchor.href).toMatch(/^https:\/\//); expect(anchor.href).not.toContain('user:pass'); expect(anchor.rel).toBe('noopener noreferrer'); expect(anchor.target).toBe('_blank'); expect(anchor.referrer).toBe('no-referrer'); }
  await expect(message.getByRole('link', { name: '[Image: Image]' })).toHaveAttribute('href', 'https://tracker.invalid/image.svg');
});

test('spoilers reveal formatted text and links without nested controls and reset after edits', async ({ page }) => {
  await fixture(page, 'Before ||**secret :cheers:** and [link](https://example.org) with `||`||. [||hidden label||](https://example.org/other)');
  const message = page.getByRole('region', { name: 'Rendered message' });
  await expect(message.getByText('secret', { exact: false })).toHaveCount(0);
  await expect(message.getByRole('img')).toHaveCount(0);
  await message.getByRole('button', { name: 'Reveal spoiler' }).first().click();
  await expect(message.locator('strong')).toContainText('secret'); await expect(message.getByRole('img', { name: 'cheers' })).toBeVisible();
  await expect(message.getByRole('link', { name: 'link', exact: true })).toBeVisible();
  await expect(message.locator('a button,button a,button button')).toHaveCount(0);
  await message.getByRole('button', { name: 'Hide spoiler' }).click(); await expect(message.getByRole('img')).toHaveCount(0);
  await message.getByRole('button', { name: 'Reveal spoiler' }).first().click();
  await page.evaluate(() => (window as any).replaceMarkdown('Changed ||new secret||'));
  await expect(message.getByRole('button', { name: 'Reveal spoiler' })).toBeVisible();
  await expect(message.getByText('new secret')).toHaveCount(0);
});

test('fenced code stays literal, highlights and copies exact code with visible failure recovery', async ({ page }) => {
  const body = 'const html = "<img src=x>";\n// :cheers: **literal** ||private||\nreturn 42;\n';
  await fixture(page, '````js\n' + body + '````\n\n`inline :cheers: **plain**`');
  const message = page.getByRole('region', { name: 'Rendered message' });
  await expect(message.getByRole('img')).toHaveCount(0); await expect(message.getByRole('button', { name: 'Reveal spoiler' })).toHaveCount(0);
  await expect(message.locator('pre code')).toHaveText(body); await expect(message.locator('.code-keyword').first()).toHaveText('const');
  await message.getByRole('button', { name: 'Copy code', exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedMarkdown)).toEqual([body]);
  await page.evaluate(() => { (window as any).clipboardDenied = true; });
  await message.getByRole('button', { name: 'Copy code again' }).click(); await expect(message.getByRole('alert')).toContainText('copy it manually');
});

test('role mentions remain inert labels and malformed custom schemes never become anchors', async ({ page }) => {
  await fixture(page, '[@Helpers](tavern-role:%21guild%3Atest/helpers) [@invalid](tavern-role:!guild:test/helpers) [unknown](custom-role:helpers)');
  const message = page.getByRole('region', { name: 'Rendered message' });
  await expect(message.locator('.mention').first()).toHaveText('@Helpers');
  await expect(message).toContainText('[@invalid](tavern-role:!guild:test/helpers)');
  await expect(message).toContainText('[unknown](custom-role:helpers)');
  await expect(message.locator('[href],button')).toHaveCount(0);
});

test('actual Tavern preview controls never disclose spoiler/code links and edits discard consent', async ({ page }) => {
  const requests: unknown[] = [];
  await page.route('**/api/link-preview', route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: 'https://visible.example/a_(b)', title: 'Visible preview', description: 'Description', siteName: 'Visible site' }) });
  });
  await fixture(page, '||https://hidden.example/secret|| `https://code.example/`\n\n```\nhttps://fenced.example/\n```\n\n[||hidden label||](https://label.example/) [visible](https://visible.example/a_(b))', false, true);
  const message = page.getByRole('region', { name: 'Rendered message' });
  await expect(message.getByRole('button', { name: /^Preview / })).toHaveCount(1);
  await expect(message.locator('.link-preview')).not.toContainText('hidden.example');
  expect(requests).toEqual([]);
  await message.getByRole('button', { name: 'Preview visible.example' }).click();
  await expect(message.getByRole('link', { name: /Visible preview/ })).toBeVisible();
  expect(requests).toEqual([{ url: 'https://visible.example/a_(b)', consent: true }]);
  await page.evaluate(() => (window as any).replaceMarkdown('||https://visible.example/a_(b)||'));
  await expect(message.locator('.link-preview')).toHaveCount(0);
  await page.evaluate(() => (window as any).replaceMarkdown('Changed https://visible.example/a_(b)'));
  await expect(message.getByRole('button', { name: 'Preview visible.example' })).toBeVisible();
  await expect(message.getByText('Visible preview')).toHaveCount(0);
  expect(requests).toHaveLength(1);
});

test('late preview responses cannot restore edited content or cross an account generation', async ({ page }) => {
  let release!: () => void;
  await page.route('**/api/link-preview', async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: 'https://visible.example/', title: 'Stale preview', description: '', siteName: '' }) });
  });
  await fixture(page, 'https://visible.example/', false, true);
  const message = page.getByRole('region', { name: 'Rendered message' });
  const request = page.waitForRequest('**/api/link-preview');
  await message.getByRole('button', { name: 'Preview visible.example' }).click(); await request;
  await page.evaluate(() => (window as any).replaceMarkdown('Edited https://visible.example/'));
  release();
  await page.waitForFunction(() => (window as any).previewResponses === 1);
  await expect(message.getByRole('button', { name: 'Preview visible.example' })).toBeVisible();
  await expect(message.getByText('Stale preview')).toHaveCount(0);
  const second = page.waitForRequest('**/api/link-preview');
  await message.getByRole('button', { name: 'Preview visible.example' }).click(); await second;
  await page.evaluate(() => { (window as any).previewAccount = {}; });
  release();
  await page.waitForFunction(() => (window as any).previewResponses === 2);
  await expect(message.getByText('Stale preview')).toHaveCount(0);
});

test('search results preserve keyboard opening while spoilers and code controls remain independent', async ({ page }) => {
  await fixture(page, '**Result** ||hidden||\n\n```js\nreturn 1;\n```', true);
  const results = page.getByRole('region', { name: 'Message search' });
  const open = results.getByRole('button', { name: 'Open message in Guild by Alice' });
  await expect(open).toBeVisible(); await expect(results.locator('button button,button a')).toHaveCount(0);
  await results.getByRole('button', { name: 'Reveal spoiler' }).click(); await results.getByRole('button', { name: 'Copy code', exact: true }).click();
  expect(await page.evaluate(() => (window as any).openedMessages)).toEqual([]);
  await open.focus(); await page.keyboard.press('Enter'); expect(await page.evaluate(() => (window as any).openedMessages)).toEqual(['$result']);
});

test('bounded fallback is collapsed and long code/table content does not expand a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, '| Name | Value |\n| --- | --- |\n| long | ' + 'x'.repeat(500) + ' |\n\n```\n' + 'x'.repeat(500) + '\n```');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => (window as any).replaceMarkdown('***'.repeat(100) + '||hidden||' + '***'.repeat(100)));
  const message = page.getByRole('region', { name: 'Rendered message' });
  await expect(message.locator('details')).not.toHaveAttribute('open', '');
  await expect(message.getByText('Message formatting is too complex. Show plain text')).toBeVisible();
  await message.locator('summary').click(); await expect(message.locator('pre')).toContainText('||hidden||');
  await page.evaluate(() => (window as any).replaceMarkdown('x'.repeat(31999) + '😀more'));
  await expect(message.getByText('Message is too long. Show shortened plain text')).toBeVisible();
  await expect(message.locator('pre')).not.toBeVisible();
  await message.locator('summary').click();
  expect(await message.locator('pre').textContent()).toBe('x'.repeat(31999));
});
