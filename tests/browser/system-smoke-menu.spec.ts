import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { openSystemMessageSettings } from '../../scripts/smoke-system-messages.mjs';

// Exercise Tavern's real header expression, real Radix primitives and the
// installed SDK's room-v12 permission calculation. Only the workspace data and
// sidebar selection button, mobile entry and outer modal are fixture boundaries.
const source = ts.createSourceFile('tavern.tsx', readFileSync('app/tavern.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let header = '', serverActions = '';
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'serverActions') serverActions = node.getText(source);
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'SidebarHeader' && node.openingElement.getText(source).includes('workspace-header')) header = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!header || !serverActions) throw new Error('The actual workspace header and server actions must be present.');
const community = ts.createSourceFile('community.ts', readFileSync('lib/community.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const permission = community.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'canEditCommunity')!.getText(community);
const boundary = ts.transpileModule(`
import {DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuTrigger,DropdownMenuSeparator} from '/components/ui/dropdown-menu.tsx';
const f=window.workspaceFixture,React=f.React,{useState}=React,{ChevronDown,Users,Settings,ShieldCheck}=f.icons;
const getMatrixClient=()=>f.client,communityEvents={layout:'io.tavern.server.layout',channel:'io.tavern.channel'};
const state=(room,type,key='')=>room?.currentState.getStateEvents(type,key)?.getContent()||{};
// This roleless Space fixture exercises the real native v12 authority. No
// custom role policy is supplied; unexpected managed-role evaluation fails.
const rolesEvent='io.tavern.roles',parseRolePolicy=()=>null,effectiveRolePermissions=()=>{throw Error('Unexpected role policy');};
${permission}
const MobileServerNavigation=()=>null,toast={error:error=>{throw error;}},navigationPreferences=()=>({favorites:[]}),setNavigationFlag=()=>{throw Error('Unexpected preference write');},roomWebhookLocations=()=>[],roomReportLocations=()=>[],canViewServerAudit=()=>false,isManagedAccount=()=>false,canBulkRedact=()=>false,copyText=()=>{};
const SidebarHeader=({children,...props})=><header {...props}>{children}</header>;
export function WorkspaceMenu(){
 const[selectedServer,setSelected]=useState('all'),[modal,setModal]=useState('');
 const directSection=selectedServer==='dms';const prefs={muted:[],focus:false},data={workspace:{name:'Tavern'},conversations:[],servers:[f.server]},currentServer=selectedServer===f.server.id?f.server:null,terms={server:'server'},chooseServer=setSelected,canInviteToRoom=()=>false,openSettings=()=>{};
 const readAction={run:()=>{}},setCreationCategory=()=>{},setCategoryRequest=()=>{},setReportTarget=()=>{},setConfirmAction=()=>{},loadBootstrap=async()=>{},openServerSettings=id=>{chooseServer(id);setModal('serverSettings');};
 ${serverActions}
 return <><style>{'[data-slot="dropdown-menu-content"][data-state="closed"]{animation-duration:1000ms!important}'}</style><button aria-label={f.server.name} onClick={()=>chooseServer(f.server.id)}>{f.server.name}</button>${header}{modal&&<div role='dialog'>{modal}</div>}</>;
}
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;

async function fixture(page: Page) {
  await page.route(url => url.pathname === '/workspace-menu-boundary.js', route => route.fulfill({ contentType: 'application/javascript', body: boundary }));
  await page.route('**/system-smoke-menu-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;(await import("/tests/browser/fixtures/workspace-menu.tsx")).mountFixture();</script></body></html>' }));
  await page.goto('/system-smoke-menu-test');
  await expect(page.locator('.workspace-select')).toBeVisible();
}

test('the actual header exposes native-authorized settings for the server selected in the sidebar', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'CI system notices test server', exact: true }).click();
  await expect(page.locator('.workspace-select strong')).toHaveText('CI system notices test server');
  await page.locator('.workspace-select').click();
  await expect(page.getByRole('menuitem', { name: 'Server settings', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the live helper waits for the closing layer and opens the actual v12 creator settings', async ({ page }) => {
  await fixture(page);
  expect(await page.evaluate(() => {
    const f = (window as any).workspaceFixture;
    return f.state.maySendStateEvent('io.tavern.server.layout', f.actor);
  })).toBe(true);
  await page.locator('.workspace-select').click();
  await page.getByRole('menuitem', { name: 'All channels', exact: true }).click();
  await expect(page.locator('.workspace-menu')).toHaveAttribute('data-state', 'closed');
  await openSystemMessageSettings(page, 'CI system notices test server');
  await expect(page.getByRole('dialog')).toHaveText('serverSettings');
});

test('the menu helper cannot bypass native permission when the actor is an ordinary joined member', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as any).workspaceFixture.client.getUserId = () => '@cibob:chat.example.test'; });
  page.setDefaultTimeout(1500);
  await expect(openSystemMessageSettings(page, 'CI system notices test server')).rejects.toThrow(/Server settings/);
  await expect(page.locator('.workspace-select')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
