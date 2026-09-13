import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { loadTs } from './load-ts.mjs';
import { PINNED_CALL_ASSET, transformCallTelemetry } from '../scripts/transform-call-telemetry.mjs';
import { conferenceFailureDiagnostic, conferenceFailureFields } from '../scripts/smoke-conference.mjs';
const protocol = loadTs('../lib/conference-telemetry-protocol.ts', {});
const cause = (message, patch = {}) => Object.assign(new Error(message), { name: 'ConnectionError', reasonName: 'InternalError', ...patch });

test('actual transformed connection-error constructor preserves a finite cause without keeping its raw error', () => {
  const file = new URL('../node_modules/@element-hq/element-call-embedded/dist/assets/' + PINNED_CALL_ASSET, import.meta.url);
  const result = transformCallTelemetry(readFileSync(file, 'utf8'), readFileSync(new URL(file + '.map'), 'utf8'));
  const ast = ts.createSourceFile('patched.js', result.code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const matches = []; function visit(node) { if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.members.some(member => ts.isConstructorDeclaration(member) && member.getText(ast).includes('__tavernCallFailure(this,'))) matches.push(node); ts.forEachChild(node, visit); } visit(ast);
  assert.equal(matches.length, 1); const target = matches[0], constructor = target.members.find(ts.isConstructorDeclaration);
  const nodes = []; function collect(node) { nodes.push(node); ts.forEachChild(node, collect); } collect(constructor.body);
  const superCall = nodes.find(s => ts.isCallExpression(s) && s.expression.kind === ts.SyntaxKind.SuperKeyword);
  const description = nodes.find(s => ts.isBinaryExpression(s) && s.left.getText(ast) === 'this.localisedMessageKey').right;
  const bindings = { __tavernCallFailure: protocol.retainConferenceFailure };
  bindings[target.heritageClauses[0].types[0].expression.getText(ast)] = class extends Error { constructor(message, code) { super(message); this.code = code; } };
  bindings[superCall.arguments[0].expression.getText(ast)] = key => key;
  for (const argument of superCall.arguments.slice(1)) assert.ok(ts.isStringLiteralLike(argument));
  bindings[description.expression.getText(ast)] = key => key;
  const Wrapped = new Function(...Object.keys(bindings), 'return (' + target.getText(ast) + ');')(...Object.values(bindings));
  const original = cause('could not establish PC connection, PRIVATE_TOKEN_URL', { status: 502 });
  const wrapped = new Wrapped(original), failure = protocol.conferenceFailure(wrapped);
  assert.equal(wrapped.cause, undefined); assert.equal(wrapped.localisedMessageValues.reason, 'InternalError');
  assert.deepEqual(failure, { code: 'SFU_ERROR', cause: 'ConnectionError', reason: 'InternalError', status: 502, matrixCode: null, detail: 'media_connection' });
  original.message = 'Changed private detail'; failure.detail = 'signaling_error';
  assert.equal(protocol.conferenceFailure(wrapped).detail, 'media_connection');
  assert.equal(JSON.stringify(wrapped).includes('PRIVATE_TOKEN'), false);
});

test('reviewed SDK connection failures produce only finite categories and reject unrelated messages', () => {
  const examples = {
    media_connection: ['could not establish pc connection', 'could not establish PC connection, PRIVATE', 'could not establish Publisher connection, state: failed', 'could not establish Subscriber connection, state: checking'],
    media_setup: ['Publisher connection not set', 'Subscriber connection not set'],
    signaling_closed: ['Websocket got closed during a (re)connection attempt: PRIVATE'],
    signaling_error: ['Websocket error during a (re)connection attempt: PRIVATE', 'Encountered unknown websocket error during connection: PRIVATE'],
    signaling_response: ['no message received as first message', 'Unexpected first message', 'did not receive join response, got PRIVATE instead'],
    server_discovery: ['Could not fetch region settings: PRIVATE'],
  };
  assert.deepEqual(Object.keys(examples).sort(), [...protocol.CONFERENCE_FAILURE_DETAILS].sort());
  assert.deepEqual(conferenceFailureFields.detail, protocol.CONFERENCE_FAILURE_DETAILS);
  for (const [detail, messages] of Object.entries(examples)) for (const message of messages) {
    const value = protocol.conferenceFailure({ code: 'SFU_ERROR', cause: cause(message) });
    assert.equal(value.detail, detail); assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
    assert.equal(conferenceFailureDiagnostic(value), 'SFU_ERROR/ConnectionError/none/InternalError/none/' + detail);
  }
  for (const inner of [cause('PRIVATE'), cause('could not establish pc connection', { name: 'TypeError' }), cause('could not establish pc connection', { reasonName: 'Cancelled' })]) assert.equal(protocol.conferenceFailure({ cause: inner }).detail, undefined);
});

test('failure packets retain optional classified details and reject raw data or unrecognized fields', () => {
  const failure = protocol.conferenceFailure({ code: 'SFU_ERROR', cause: cause('could not establish pc connection') });
  const packet = { type: protocol.CALL_TELEMETRY_TYPE, version: 1, widgetId: 'widget_nonce_123456789012345', session: 'session_nonce_123456789012345', roomId: '!voice:local', document: 'document_nonce_123456789012345', sequence: 1, connected: false, reconnecting: false, participants: [], complete: false, e2eeEnabled: null, metrics: protocol.emptyConferenceMetrics(), failure };
  assert.deepEqual(protocol.parseConferenceTelemetry(packet).failure, failure);
  for (const patch of [{ detail: 'PRIVATE' }, { detail: undefined }, { detail: null }, { message: 'PRIVATE' }, { stack: 'PRIVATE' }]) {
    assert.equal(protocol.parseConferenceTelemetry({ ...packet, failure: { ...failure, ...patch } }), null);
    assert.equal(conferenceFailureDiagnostic({ ...failure, ...patch }), 'unavailable');
  }
  const legacy = { ...failure }; delete legacy.detail;
  assert.deepEqual(protocol.parseConferenceTelemetry({ ...packet, failure: legacy }).failure, legacy);
});
