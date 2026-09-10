import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { loadTs } from './load-ts.mjs';
import { PINNED_CALL_ASSET, transformCallTelemetry } from '../scripts/transform-call-telemetry.mjs';

const protocol = loadTs('../lib/conference-telemetry-protocol.ts', {});
const { attachEmbeddedCallTelemetry } = loadTs('../lib/embedded-call-telemetry.ts', { './conference-telemetry-protocol.js': protocol });
const nonce = 'abcdefgh-1234-4567-8901-abcdefgh1234', widget = 'widgetab-1234-4567-8901-abcdefgh1234', roomId = '!voice:local';
class Behavior {
  listeners = new Set();
  constructor(value) { this.value = value; }
  subscribe(observer) { this.listeners.add(observer); observer.next(this.value); return { unsubscribe: () => this.listeners.delete(observer) }; }
  set(value) { this.value = value; for (const observer of this.listeners) observer.next(value); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(context) {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const messages = [], ends = [], host = new EventTarget();
  host.location = { href: 'https://tavern.test/element-call/index.html#?' + new URLSearchParams({ widgetId: widget, tavernTelemetry: nonce, roomId, parentUrl: 'https://tavern.test' }) };
  host.parent = { postMessage: (body, origin) => messages.push({ body, origin }) };
  const room = { roomId, membership: 'join', getMyMembership() { return this.membership; }, getMember: user => ({ membership: 'join', name: user === '@me:local' ? 'Me' : 'Remote member', getMxcAvatarUrl: () => 'mxc://local/avatar' }) };
  room.client = { getUserId: () => '@me:local', getDeviceId: () => 'LOCAL', getHomeserverUrl: () => 'https://tavern.test', getRoom: () => room };
  let packets = 90, lost = 10, reads = 0;
  const track = { getRTCStatsReport: async () => { reads++; return new Map([['secret', { type: 'local-candidate', address: '10.0.0.1', secret: 'never-copy' }], ['rtp', { type: 'inbound-rtp', id: 'audio', kind: 'audio', packetsReceived: packets, packetsLost: lost, jitter: .007, roundTripTime: .042 }]]); } };
  const audio = { isMuted: false, isEncrypted: true, track }, participant = new EventEmitter();
  Object.assign(participant, { identity: 'backend-attested', isLocal: false, isSpeaking: false, getTrackPublication: source => source === 'microphone' ? audio : undefined });
  const connection = { livekitRoom: { state: 'connected', isE2EEEnabled: true } };
  const member = { userId: '@remote:local', membership$: new Behavior({ userId: '@remote:local', deviceId: 'REMOTE', rtcBackendIdentity: 'backend-attested' }), participant: { value$: new Behavior(participant) }, connection$: new Behavior(connection) };
  const view = { localMatrixLivekitMember$: new Behavior(null), remoteMatrixLivekitMembers$: new Behavior([member]), connected$: new Behavior(true), reconnecting$: new Behavior(false) };
  const scope = { onEnd: callback => ends.push(callback) };
  context.after(() => { for (const end of ends) end(); });
  return { host, room, member, participant, connection, audio, track, view, scope, messages, ends, reads: () => reads, advancePackets: () => { packets += 95; lost += 5; } };
}

test('pinned asset transformation wraps only the attested view return and preserves upstream source mappings', () => {
  const file = new URL('../node_modules/@element-hq/element-call-embedded/dist/assets/' + PINNED_CALL_ASSET, import.meta.url);
  const code = readFileSync(file, 'utf8'), mapText = readFileSync(new URL(file + '.map'), 'utf8');
  const result = transformCallTelemetry(code, mapText);
  assert.equal((result.code.match(/__tavernCallTelemetry\(/g) || []).length, 1);
  assert.match(result.code, /__tavernCallTelemetry\(e,n,\{/);
  const token = 'remoteMatrixLivekitMembers$:', offset = result.code.indexOf(token, result.code.indexOf('__tavernCallTelemetry(e,n,'));
  const line = result.code.slice(0, offset).split('\n');
  const original = originalPositionFor(new TraceMap(JSON.parse(result.map)), { line: line.length, column: line.at(-1).length });
  assert.ok(original.source.endsWith('src/state/CallViewModel/CallViewModel.ts'));
  assert.ok(JSON.parse(result.map).sourcesContent.some(source => source?.includes('export function createCallViewModel$(')));
  assert.equal(ts.createSourceFile('patched.js', result.code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS).parseDiagnostics.length, 0);
  assert.throws(() => transformCallTelemetry(code + ' ', mapText), /source changed/);
  assert.throws(() => transformCallTelemetry(code, mapText + ' '), /source changed/);
});

test('actual pinned audio voice intent disables initial video before media-device state is created', () => {
  const directory = new URL('../node_modules/@element-hq/element-call-embedded/dist/assets/', import.meta.url);
  const maps = ['index-DPkEeOAp.js.map', 'matrix-DEcBaNuH.js.map'].map(name => JSON.parse(readFileSync(new URL(name, directory), 'utf8')));
  const source = suffix => { const map = maps.find(m => m.sources.some(s => s.endsWith(suffix))); return map.sourcesContent[map.sources.findIndex(s => s.endsWith(suffix))]; };
  const evaluate = (text, deps) => { const exports = {}, output = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }); new Function('exports', 'require', output.outputText)(exports, name => { if (!(name in deps)) throw new Error(name); return deps[name]; }); return exports; };
  const logger = { debug() {}, info() {} };
  const urls = evaluate(source('/UrlParams.ts'), { react: {}, 'react-router-dom': {}, 'matrix-js-sdk/lib/logger': { logger }, 'lodash-es': { pickBy: (object, predicate) => Object.fromEntries(Object.entries(object).filter(([, value]) => predicate(value))) }, './config/Config': {}, './e2ee/e2eeType': {}, './Platform': { platform: 'desktop' }, './utils/redact': { redact: x => x } });
  const initial = evaluate(source('/initialMuteState.ts'), { 'matrix-js-sdk/lib/logger': { logger } });
  for (const intent of ['start_call_voice', 'join_existing_voice']) {
    const params = urls.computeUrlParams('', '#?' + new URLSearchParams({ widgetId: widget, parentUrl: 'https://tavern.test', intent }));
    assert.equal(params.callIntent, 'audio'); assert.equal(params.skipLobby, false);
    assert.deepEqual(initial.calculateInitialMuteState(params.skipLobby, params.callIntent, true), { audioEnabled: true, videoEnabled: false });
  }
  assert.match(source('/MuteStates.ts'), /this\.mediaDevices\.videoInput,\s*this\.initialMuteState\.videoEnabled/);
});

test('bridge uses existing attested participants and actual numeric RTP samples without publishing raw report data', async context => {
  const f = fixture(context); assert.equal(attachEmbeddedCallTelemetry(f.scope, f.room, f.view, f.host), f.view);
  await flush(); context.mock.timers.tick(200);
  const first = f.messages.at(-1); assert.equal(first.origin, 'https://tavern.test');
  assert.equal(first.body.participants[0].userId, '@remote:local'); assert.equal(first.body.participants[0].avatarMxc, 'mxc://local/avatar');
  assert.equal(first.body.e2eeEnabled, true); assert.equal(first.body.participants[0].encrypted, true);
  assert.deepEqual(first.body.metrics, { rttMs: 42, jitterMs: 7, packetLossPercent: null, sampledTracks: 1, totalTracks: 1 });
  assert.equal(JSON.stringify(first).includes('10.0.0.1'), false); assert.equal(JSON.stringify(first).includes('never-copy'), false);
  f.advancePackets(); context.mock.timers.tick(2000); await flush(); context.mock.timers.tick(200);
  assert.equal(f.messages.at(-1).body.metrics.packetLossPercent, 5);
  f.participant.isSpeaking = true; f.participant.emit('isSpeakingChanged'); context.mock.timers.tick(200);
  assert.equal(f.messages.at(-1).body.participants[0].speaking, true);
  f.connection.livekitRoom.isE2EEEnabled = false; f.audio.isEncrypted = false; f.participant.emit('trackMuted'); context.mock.timers.tick(200);
  assert.equal(f.messages.at(-1).body.e2eeEnabled, false); assert.equal(f.messages.at(-1).body.participants[0].encrypted, false);
  f.member.membership$.set({ ...f.member.membership$.value, rtcBackendIdentity: 'other-device' }); context.mock.timers.tick(200);
  assert.deepEqual(f.messages.at(-1).body.participants, []); assert.equal(f.messages.at(-1).body.e2eeEnabled, null);
});

test('bridge cleanup and replacement scope remove observers and ignore late stats without new capture or connections', async context => {
  const f = fixture(context); let release; f.track.getRTCStatsReport = () => new Promise(resolve => { release = resolve; });
  attachEmbeddedCallTelemetry(f.scope, f.room, f.view, f.host); await flush(); context.mock.timers.tick(200);
  f.ends[0](); const before = f.messages.length;
  release(new Map()); await flush(); context.mock.timers.tick(5000);
  assert.equal(f.messages.length, before); assert.equal(f.participant.eventNames().length, 0); assert.equal(f.member.participant.value$.listeners.size, 0);
  assert.equal(f.view.connected$.listeners.size, 0);
  attachEmbeddedCallTelemetry(f.scope, f.room, f.view, f.host); await flush(); context.mock.timers.tick(200);
  const second = f.messages.length; f.host.location.href += '&replacement=1'; context.mock.timers.tick(1000);
  f.participant.emit('isSpeakingChanged'); context.mock.timers.tick(300); assert.equal(f.messages.length, second);
});

test('stalled RTC report reads are bounded, shared across ticks, and never label unavailable values healthy', async context => {
  const f = fixture(context); let reads = 0; f.track.getRTCStatsReport = () => { reads++; return new Promise(() => {}); };
  attachEmbeddedCallTelemetry(f.scope, f.room, f.view, f.host); await flush(); context.mock.timers.tick(1600); await flush(); context.mock.timers.tick(200);
  assert.equal(f.messages.at(-1).body.metrics.rttMs, null); assert.equal(f.messages.at(-1).body.metrics.sampledTracks, 0);
  context.mock.timers.tick(2200); await flush(); context.mock.timers.tick(1600); await flush(); context.mock.timers.tick(200);
  assert.equal(reads, 1);
});

test('late participant replacement invalidates sampled stats and capped roster reports partial coverage', async context => {
  const f = fixture(context); let release; f.track.getRTCStatsReport = () => new Promise(resolve => { release = resolve; });
  attachEmbeddedCallTelemetry(f.scope, f.room, f.view, f.host); await flush();
  f.member.participant.value$.set(null); release(new Map([['rtp', { type: 'inbound-rtp', kind: 'audio', jitter: 10 }]])); await flush(); context.mock.timers.tick(200);
  assert.deepEqual(f.messages.at(-1).body.participants, []); assert.equal(f.messages.at(-1).body.metrics.jitterMs, null);
  f.view.remoteMatrixLivekitMembers$.set(Array(129).fill(f.member)); context.mock.timers.tick(200);
  assert.equal(f.messages.at(-1).body.complete, false);
  f.room.membership = 'leave'; context.mock.timers.tick(1000); assert.equal(f.view.remoteMatrixLivekitMembers$.listeners.size, 0);
});

test('replacement view keeps the widget sequence monotonic and an already-ended scope installs nothing', async context => {
  const f = fixture(context); attachEmbeddedCallTelemetry(f.scope, f.room, f.view, f.host); await flush(); context.mock.timers.tick(400);
  const before = f.messages.at(-1).body.sequence;
  attachEmbeddedCallTelemetry(f.scope, f.room, f.view, f.host); await flush(); context.mock.timers.tick(200);
  assert.ok(f.messages.at(-1).body.sequence > before); assert.equal(f.participant.listenerCount('isSpeakingChanged'), 1);
  f.ends.at(-1)(); attachEmbeddedCallTelemetry({ onEnd: callback => callback() }, f.room, f.view, f.host); context.mock.timers.tick(3000);
  assert.equal(f.participant.listenerCount('isSpeakingChanged'), 0); assert.equal(f.view.connected$.listeners.size, 0);
});

test('same-participant track replacement and widget actor changes discard stale observations', async context => {
  const f = fixture(context); let release; f.track.getRTCStatsReport = () => new Promise(resolve => { release = resolve; });
  attachEmbeddedCallTelemetry(f.scope, f.room, f.view, f.host); await flush();
  f.audio.track = { getRTCStatsReport: async () => new Map() };
  release(new Map([['rtp', { type: 'inbound-rtp', kind: 'audio', jitter: 10 }]])); await flush(); context.mock.timers.tick(200);
  assert.equal(f.messages.at(-1).body.metrics.jitterMs, null);
  const before = f.messages.length; f.room.client.getUserId = () => '@replacement:local'; context.mock.timers.tick(2000); await flush(); context.mock.timers.tick(200);
  assert.equal(f.messages.length, before); assert.equal(f.participant.listenerCount('isSpeakingChanged'), 0);
});

test('protocol rejects unknown fields, identities, booleans, nonfinite metrics and excessive participant data', async context => {
  const f = fixture(context); attachEmbeddedCallTelemetry(f.scope, f.room, f.view, f.host); await flush(); context.mock.timers.tick(200);
  const good = f.messages.at(-1).body; assert.ok(protocol.parseConferenceTelemetry(good));
  for (const mutate of [v => { v.token = 'never'; }, v => { v.metrics.rttMs = NaN; }, v => { v.participants[0].speaking = 1; }, v => { v.participants[0].avatarMxc = 'https://external.invalid/profile'; }, v => { v.participants = Array(129).fill(v.participants[0]); }, v => { v.participants.push(v.participants[0]); }]) {
    const value = structuredClone(good); mutate(value); assert.equal(protocol.parseConferenceTelemetry(value), null);
  }
});
