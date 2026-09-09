import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import MarkdownIt from 'markdown-it';
import { loadTs } from './load-ts.mjs';
import { privateFixture } from './fixtures/private-thread.mjs';

// Exercise the actual Matrix send branch, including preflight ordering and the
// existing SDK transaction calls. Only the SDK boundary itself is controlled.
const source = ts.createSourceFile('matrix.ts', readFileSync('lib/matrix.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const matrixApi = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'matrixApi');
const branch = matrixApi.body.statements.find(node => ts.isIfStatement(node) && node.expression.getText(source) === "action==='send'").getText(source);
const compiled = ts.transpileModule('async function send(p:any){const c=client,me=c.getUserId(),action="send";' + branch + '}', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const token = loadTs('../lib/role-mention-token.ts', {});
function setup() {
  const f = privateFixture(); f.ownerGeneration = {}; f.pendingFiles = new Map(); f.messages.set(f.sourceId, []);
  for (const room of f.client.getRooms()) room.getJoinedMemberCount = () => room.getJoinedMembers().length;
  f.policy.roles[1].mentionable = true; f.policy.roles[1].name = 'Helpers'; f.policy.members[f.member] = ['mod'];
  const roles = loadTs('../lib/roles.ts', { './matrix': { getMatrixClient: () => f.client } });
  const privateThreads = loadTs('../lib/private-threads.ts', { './member-state': loadTs('../lib/member-state.ts', {}), './matrix': { getMatrixClient: () => f.client }, './roles': roles });
  const markdown = loadTs('../lib/message-markdown.ts', { 'markdown-it': { default: MarkdownIt }, './role-mention-token': token });
  const helper = loadTs('../lib/role-mentions.ts', { './message-markdown': markdown, './roles': roles, './private-threads': privateThreads, './role-mention-token': token });
  const runtime = new Function('f', 'helper', 'let client=f.client;const accountArtworkOwner=()=>f.ownerGeneration,pendingFiles=f.pendingFiles,notify=()=>{},safeString=value=>typeof value==="string"?value:"",readServerEmoji=()=>[],serverEmojiHtml=()=>null,roomRequired=id=>client.getRoom(id);const {expandRoleMentions,checkRoleMentionSize}=helper;' + compiled + ';return{send,replaceClient(value){client=value}};')(f, helper);
  return { ...f, fixture: f, runtime, body: token.roleMentionToken({ serverId: f.serverId, roleId: 'mod', name: 'Helpers' }), send: changes => runtime.send({ conversation: f.sourceId, body: 'Hi', nonce: 'stable-outbox-transaction', ...changes }) };
}
test('actual send builds native explicit mentions with current roles and existing person/everyone semantics', async () => {
  const f = setup(); await f.send({ body: f.body + ' @Charlie @everyone', serverId: '!forged:test' });
  assert.equal(f.writes.length, 1); const sent = f.writes[0];
  assert.equal(sent.transactionId, 'stable-outbox-transaction'); assert.equal(sent.roomId, f.sourceId);
  assert.deepEqual(new Set(sent.content['m.mentions'].user_ids), new Set([f.author, f.member, f.other]));
  assert.equal(sent.content['m.mentions'].room, true); assert.equal(sent.content.body, f.body + ' @Charlie @everyone');
});
test('forward suppression short-circuits invalid role parsing, membership and all notification expansion', async () => {
  const f = setup(); for (const room of f.client.getRooms()) room.loadMembersIfNeeded = async () => { throw new Error('Must not load'); };
  await f.send({ body: '[@role](tavern-role:invalid/x) @everyone @Bob', suppressMentions: true });
  assert.deepEqual(f.writes[0].content['m.mentions'], { user_ids: [] });
});

test('reference role labels do not also mention a same-name person or the whole room', async () => {
  const f = setup();
  const uri = token.roleMentionUri(f.serverId, 'mod');
  await f.send({ body: '[@everyone][role] [@Charlie][role]\n\n[role]: ' + uri });
  assert.deepEqual(new Set(f.writes[0].content['m.mentions'].user_ids), new Set([f.author, f.member]));
  assert.equal(f.writes[0].content['m.mentions'].room, undefined);
});

test('hidden role examples and malformed reserved links cannot fall back to room-wide alerts', async () => {
  const valid = '[@everyone](tavern-role:%21server%3Atest/mod)';
  for (const body of ['> ' + valid, '||' + valid + '||', '`' + valid + '`', '```\n' + valid + '\n```', '[@everyone](tavern-role:invalid/role)', '[@everyone](TAVERN-ROLE:%21server%3Atest/mod)']) {
    const f = setup();
    await f.send({ body: body + '\n\n@Charlie' });
    assert.deepEqual(f.writes[0].content['m.mentions'], { user_ids: [f.other] }, body);
  }
});

test('escaped ambiguous role examples keep the draft and attachments without any SDK send', async () => {
  const f = setup();
  const body = '\\[@everyone](tavern-role:%21server%3Atest/mod) @Charlie';
  f.pendingFiles.set('file', { roomId: f.sourceId, type: 'application/octet-stream', name: 'ciphertext', size: 32, file: { url: 'mxc://test/ciphertext' } });
  await assert.rejects(f.send({ body, attachments: ['file'] }), /role example is ambiguous.*draft is kept/);
  assert.equal(f.writes.length, 0); assert.equal(f.pendingFiles.size, 1);
  await f.send({ body, suppressMentions: true });
  assert.deepEqual(f.writes[0].content['m.mentions'], { user_ids: [] });
});

test('same-client actor replacement during ordinary or inactive-role preflight prevents every send', async () => {
  for (const body of ['Ordinary message @everyone', '`[@everyone](tavern-role:%21server%3Atest/mod)`']) {
    const f = setup(), pending = f.send({ body });
    f.client.getUserId = () => '@replacement:test';
    await assert.rejects(pending, /account or conversation changed/);
    assert.equal(f.writes.length, 0);
  }
});

test('suppressed forwarding rechecks the same-client actor after an attachment acknowledgement', async () => {
  const f = setup();
  f.pendingFiles.set('file', { roomId: f.sourceId, type: 'application/octet-stream', name: 'ciphertext', size: 32, file: { url: 'mxc://test/ciphertext' } });
  const nativeSend = f.client.sendMessage;
  f.client.sendMessage = async (...args) => { const result = await nativeSend(...args); f.client.getUserId = () => '@replacement:test'; return result; };
  await assert.rejects(f.send({ body: f.body, attachments: ['file'], suppressMentions: true }), /account or conversation changed/);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].content.msgtype, 'm.file'); assert.equal(f.pendingFiles.size, 1);
});
test('oversized recipient encoding fails before any SDK attachment or text send and retains pending files', async () => {
  const f = setup();
  for (let index = 0; index < 80; index++) {
    const user = '@user' + index + ':' + 'x'.repeat(255); f.policy.members[user] = ['mod'];
    for (const id of [f.sourceId, f.serverId]) f.states.get(id).push(f.event('m.room.member', user, { membership: 'join', displayname: 'Long identity' }));
  }
  f.pendingFiles.set('file', { roomId: f.sourceId, type: 'application/octet-stream', name: 'existing encrypted attachment', size: 32, file: { url: 'mxc://test/ciphertext' } });
  await assert.rejects(f.send({ body: f.body, attachments: ['file'] }), /mentions are too large/);
  assert.equal(f.writes.length, 0); assert.equal(f.pendingFiles.size, 1);
});
test('durable outbox token resolves current role state at delivery and does not retarget a renamed duplicate', async () => {
  const f = setup(); f.policy.roles[1].name = 'Renamed';
  await f.send({ body: f.body }); assert.deepEqual(new Set(f.writes[0].content['m.mentions'].user_ids), new Set([f.author, f.member]));
  f.policy.roles[1].mentionable = false;
  await assert.rejects(f.send({ body: f.body, nonce: 'later' }), /no longer mentionable/); assert.equal(f.writes.length, 1);
});
test('recipient drift after asynchronous attachment delivery is reported before sending text to stale roles', async () => {
  const f = setup(); f.pendingFiles.set('file', { roomId: f.sourceId, type: 'application/octet-stream', name: 'ciphertext', size: 32, file: { url: 'mxc://test/ciphertext' } });
  const nativeSend = f.client.sendMessage;
  f.client.sendMessage = async (...args) => { const result = await nativeSend(...args); f.policy.members[f.member] = []; return result; };
  await assert.rejects(f.send({ body: f.body, attachments: ['file'] }), /recipients changed/);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].content.msgtype, 'm.file'); assert.equal(f.pendingFiles.size, 1);
});
