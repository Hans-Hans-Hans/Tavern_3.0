import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from 'matrix-js-sdk';
import * as nativeCall from 'matrix-js-sdk/lib/webrtc/call.js';
import { CallFeed } from 'matrix-js-sdk/lib/webrtc/callFeed.js';
import { SDPStreamMetadataPurpose } from 'matrix-js-sdk/lib/webrtc/callEventTypes.js';
import { CallEventHandlerEvent } from 'matrix-js-sdk/lib/webrtc/callEventHandler.js';
import { loadTs } from './load-ts.mjs';

const relay = loadTs('../lib/call-relay.ts', { './turn-diagnostics': loadTs('../lib/turn-diagnostics.ts', {}) });
const fresh = () => ({ uris: ['turn:fixture.invalid:3478?transport=udp'], username: 'fixture-only-user', password: 'fixture-only-secret', ttl: 3600 });
async function fixture(task) {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  const f = { account: {}, actor: '@receiver:local', device: 'RECEIVER', base: 'https://fixture.invalid/api/matrix', peers: [], answered: [], room: { hasEncryptionStateEvent: () => true, getMyMembership: () => 'join', getJoinedMemberCount: () => 2 } };
  class Peer {
    constructor(config) { this.config = structuredClone(config); this.initial = structuredClone(config); this.signalingState = 'stable'; this.connectionState = 'new'; this.localDescription = null; this.updates = 0; f.peers.push(this); }
    getConfiguration() { return structuredClone(this.config); }
    setConfiguration(value) { if (f.badConfiguration) throw new Error('private browser detail'); this.config = structuredClone(value); this.updates++; }
    addEventListener() {} removeEventListener() {}
    async setRemoteDescription() { if (this.signalingState === 'closed') throw new Error('Peer is closed'); this.signalingState = 'have-remote-offer'; }
    close() { this.signalingState = this.connectionState = 'closed'; }
    async getStats() { return new Map(); }
  }
  globalThis.window = { RTCPeerConnection: Peer }; globalThis.document = {};
  const client = sdk.createClient({ baseUrl: f.base, userId: f.actor, deviceId: f.device, forceTURN: true });
  client.supportsVoip = () => true; client.isVoipWithNoMediaAllowed = true;
  client.getUserId = () => f.actor; client.getDeviceId = () => f.device; client.getHomeserverUrl = () => f.base; client.getRoom = () => f.room;
  client.turnServer = async () => { if (f.beforeTurn) await f.beforeTurn(); return fresh(); };
  client.getMediaHandler().restoreMediaSettings = () => {};
  const calls = loadTs('../lib/calls.ts', { './media-session': loadTs('../lib/media-session.ts', {}), 'matrix-js-sdk': sdk,
    'matrix-js-sdk/lib/webrtc/callFeed': { CallFeed }, 'matrix-js-sdk/lib/webrtc/callEventTypes': { SDPStreamMetadataPurpose },
    'matrix-js-sdk/lib/webrtc/callEventHandler': { CallEventHandlerEvent }, 'matrix-js-sdk/lib/webrtc/call': nativeCall,
    './instance': { readInstanceConfig: async () => ({ callsEnabled: true }) }, './api': { accountArtworkOwner: () => f.account }, './call-relay': relay, './call-dismissal': loadTs('../lib/call-dismissal.ts', {}) });
  f.call = () => {
    const call = client.createCall('!dm:local');
    call.getOpponentMember = () => ({ userId: '@sender:local' }); call.initOpponentCrypto = async () => {}; call.chooseOpponent = () => {};
    call.hangup = () => { call.state = nativeCall.CallState.Ended; call.peerConn?.close(); call.emit(sdk.CallEvent.Hangup, call); };
    call.reject = call.hangup;
    call.answer = async () => { f.answered.push(call.peerConn.getConfiguration()); call.state = nativeCall.CallState.Connecting; };
    return call;
  };
  f.invite = call => call.initWithInvite({ getContent: () => ({ offer: { type: 'offer', sdp: 'fixture-boundary' }, lifetime: 60000 }), getLocalAge: () => 0 });
  f.incoming = call => client.emit(CallEventHandlerEvent.Incoming, call);
  f.client = client; f.calls = calls; calls.initializeCalls(client);
  try { await task(f); } finally { calls.resetCalls(); client.stopClient(); globalThis.window = oldWindow; globalThis.document = oldDocument; }
}

test('actual SDK incoming construction repairs its stale empty TURN snapshot before remote SDP and before any user/automatic answer', () => fixture(async f => {
  const call = f.call(); assert.equal(f.client.getTurnServers().length, 0);
  await f.invite(call);
  const peer = call.peerConn;
  assert.equal(peer.initial.iceServers, undefined, 'pinned SDK constructed from its old empty array');
  assert.equal(f.client.getTurnServers().length, 1);
  assert.equal(peer.updates, 1, 'the current client event repairs the peer before Incoming is emitted');
  assert.equal(peer.config.iceTransportPolicy, 'relay'); assert.deepEqual(peer.config.iceServers[0].urls, fresh().uris);
  assert.equal(peer.signalingState, 'have-remote-offer');
  f.incoming(call); await f.calls.answerCall(false);
  assert.equal(f.answered.length, 1); assert.equal(f.answered[0].iceServers[0].username, fresh().username);
  assert.equal(f.answered[0].iceTransportPolicy, 'relay');
}));

test('SDK internal outgoing refresh replaces its captured old credentials and the initial peer receives the new ones', () => fixture(async f => {
  f.client.turnServers = [{ urls: ['turn:expired.invalid:3478'], username: 'old', credential: 'old' }]; f.client.turnServersExpiry = 0;
  const call = f.call(); call.on(sdk.CallEvent.Error, () => {}); call.gotCallFeedsForInvite = () => {};
  await call.placeCallWithCallFeeds([]);
  assert.equal(call.peerConn.initial.iceServers[0].username, 'old');
  assert.equal(call.peerConn.config.iceServers[0].username, fresh().username);
  assert.equal(call.peerConn.config.iceTransportPolicy, 'relay');
}));

test('answer refresh failure rejects an otherwise populated stale cache without capture or answer', () => fixture(async f => {
  const call = f.call(); await f.invite(call); f.incoming(call);
  const before = call.peerConn.updates;
  f.client.checkTurnServers = async () => false;
  await assert.rejects(f.calls.answerCall(false), /fresh relay credentials/);
  assert.equal(f.answered.length, 0); assert.equal(call.peerConn.updates, before); assert.equal(f.calls.callSnapshot().busy, false);
}));

test('a late concurrent refresh error does not poison a later successful SDK cache-hit incoming call', () => fixture(async f => {
  const pending = [];
  f.client.turnServer = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const first = f.client.checkTurnServers(), late = f.client.checkTurnServers();
  pending[0].resolve(fresh()); assert.equal(await first, true);
  pending[1].reject(new Error('fixture refresh unavailable')); assert.equal(await late, false);
  // The real SDK now returns true from cache without emitting TurnServers.
  const call = f.call(); await f.invite(call);
  assert.equal(pending.length, 2); assert.equal(call.peerConn.updates, 1);
  assert.equal(call.peerConn.signalingState, 'have-remote-offer');
  f.incoming(call); await f.calls.answerCall(false); assert.equal(f.answered.length, 1);
}));

for (const kind of ['account', 'actor', 'device', 'base', 'room', 'ended']) test(`answer refresh cannot reconfigure or answer a retired ${kind}`, () => fixture(async f => {
  const call = f.call(); await f.invite(call); f.incoming(call);
  let release; f.client.checkTurnServers = () => new Promise(resolve => { release = () => resolve(true); });
  const answer = f.calls.answerCall(false), before = call.peerConn.updates;
  while (!release) await new Promise(resolve => setImmediate(resolve));
  if (kind === 'account') f.account = {};
  if (kind === 'actor') f.actor = '@replacement:local';
  if (kind === 'device') f.device = 'REPLACEMENT';
  if (kind === 'base') f.base = 'https://other.invalid';
  if (kind === 'room') f.room = { ...f.room };
  if (kind === 'ended') f.calls.endCall();
  release(); await assert.rejects(answer, /canceled/);
  assert.equal(f.answered.length, 0); assert.equal(call.peerConn.updates, before);
}));

test('initial configuration failure is contained by the native listener and never answers the failed peer', () => fixture(async f => {
  f.badConfiguration = true; const call = f.call();
  await assert.doesNotReject(f.invite(call));
  assert.equal(call.peerConn.connectionState, 'closed'); assert.equal(call.state, nativeCall.CallState.Ended);
  f.incoming(call); assert.equal(f.calls.callSnapshot().call, null); assert.equal(f.answered.length, 0);
}));

test('a handled invitation replay closes only the replayed SDK peer and sends no second hangup to the other device', () => fixture(async f => {
  const first = f.call(); first.callId = 'handled'; await f.invite(first); f.incoming(first);
  f.calls.endCall(); assert.equal(f.calls.callSnapshot().call, null);
  const replay = f.call(); replay.callId = 'handled'; await f.invite(replay);
  let suppressed; const hangup = replay.hangup; replay.hangup = (reason, suppressEvent) => { suppressed = suppressEvent; hangup(); };
  f.incoming(replay); assert.equal(f.calls.callSnapshot().call, null); assert.equal(replay.peerConn.connectionState, 'closed'); assert.equal(suppressed, true);
  const next = f.call(); next.callId = 'new-call'; await f.invite(next); f.incoming(next);
  assert.equal(f.calls.callSnapshot().call, next);
}));

test('group calls, established peers and retired client listeners are never rerouted', () => fixture(async f => {
  const call = f.call(); call.groupCallId = 'native-group'; await f.invite(call); assert.equal(call.peerConn.updates, 0);
  call.groupCallId = undefined; call.peerConn.localDescription = { type: 'answer' }; call.peerConn.connectionState = 'connected';
  f.client.emit(sdk.CallEvent.PeerConnectionCreated, call.peerConn, call); assert.equal(call.peerConn.updates, 0);
  f.calls.resetCalls(); call.peerConn.localDescription = null; call.peerConn.connectionState = 'new';
  f.client.emit(sdk.CallEvent.PeerConnectionCreated, call.peerConn, call); assert.equal(call.peerConn.updates, 0);
}));

test('fresh relay validation rejects missing, nonfinite, short-lived, expired and non-TURN configuration', async () => {
  const client = { checkTurnServers: async () => true, getTurnServersExpiry: () => Date.now() + 3600000,
    getTurnServers: () => [{ urls: fresh().uris, username: fresh().username, credential: fresh().password }] };
  for (const expiry of [NaN, undefined, Infinity, -1, Date.now() + 1000, '9999999999999']) {
    await assert.rejects(relay.refreshCallRelay({ ...client, getTurnServersExpiry: () => expiry }, () => true), /fresh relay credentials/);
  }
  for (const urls of [['stun:public.invalid:3478'], ['https://private.invalid?token=private'], []]) {
    await assert.rejects(relay.refreshCallRelay({ ...client, getTurnServers: () => [{ urls, username: 'fixture', credential: 'fixture' }] }, () => true), /fresh relay credentials/);
  }
});
