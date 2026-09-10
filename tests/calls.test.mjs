import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadTs } from './load-ts.mjs';

function setup(enabled = true) {
  const ownership = loadTs('../lib/media-session.ts', {});
  const track = { enabled: true, stop() { this.stopped = true; } };
  const stream = { id: 'microphone', getAudioTracks: () => [track], getTracks: () => [track] };
  class Feed { constructor(options) { Object.assign(this, options); } setAudioVideoMuted(value) { this.audioMuted = value; } }
  class Call extends EventEmitter {
    constructor() { super(); this.callId = 'call'; this.roomId = '!dm:local'; this.state = 'connected'; this.localUsermediaFeed = new Feed({ stream, audioMuted: false }); this.localUsermediaStream = stream; this.metadata = []; }
    isRemoteOnHold() { return false; }
    isMicrophoneMuted() { return this.localUsermediaFeed.audioMuted; }
    async setMicrophoneMuted(muted) { this.localUsermediaFeed.audioMuted = muted; track.enabled = !muted; }
    async sendMetadataUpdate() { this.metadata.push(this.isMicrophoneMuted()); if (this.send) await this.send(); }
    async placeVoiceCall() {}
    async placeCallWithCallFeeds(feeds) { this.initialMuted = !feeds[0].stream.getAudioTracks()[0].enabled; this.localUsermediaFeed = feeds[0]; }
    hangup() { this.state = 'ended'; this.emit('hangup'); }
  }
  const call = new Call(), mediaHandler = { restoreMediaSettings() {}, async setMediaInputs() {}, async setAudioSettings() {}, stopUserMediaStream(stream) { stream.getTracks().forEach(track => track.stop()); }, async getUserMediaStream() { return stream; } };
  const room = { hasEncryptionStateEvent: () => true, getMyMembership: () => 'join', getJoinedMemberCount: () => 2 };
  const client = new EventEmitter(); Object.assign(client, { getMediaHandler: () => mediaHandler, getUserId: () => '@me:local', getDeviceId: () => 'DEVICE', getHomeserverUrl: () => 'https://local/api/matrix', checkTurnServers: async () => true, getTurnServersExpiry: () => Date.now() + 3600000, getTurnServers: () => [{ urls: ['turn:turn.local'], username: 'fixture', credential: 'fixture' }], getRoom: () => room, createCall: () => call });
  const relay = loadTs('../lib/call-relay.ts', { './turn-diagnostics': loadTs('../lib/turn-diagnostics.ts', {}) });
  const calls = loadTs('../lib/calls.ts', {
    './media-session': ownership,
    'matrix-js-sdk': { CallEvent: { State: 'state', FeedsChanged: 'feeds', Hangup: 'hangup', Error: 'failure', Replaced: 'replaced', PeerConnectionCreated: 'peer-created' }, CallFeedEvent: { NewStream: 'stream', MuteStateChanged: 'mute' }, ClientEvent: { TurnServers: 'turn-servers', TurnServersError: 'turn-error' } },
    './api': { accountArtworkOwner: () => client }, './call-relay': relay,
    'matrix-js-sdk/lib/webrtc/callFeed': { CallFeed: Feed },
    'matrix-js-sdk/lib/webrtc/callEventTypes': { SDPStreamMetadataPurpose: { Usermedia: 'usermedia' } },
    './instance': { readInstanceConfig: async () => ({ callsEnabled: enabled }) },
    'matrix-js-sdk/lib/webrtc/callEventHandler': { CallEventHandlerEvent: { Incoming: 'incoming' } },
    'matrix-js-sdk/lib/webrtc/call': { CallErrorCode: { UserHangup: 'hangup' }, CallState: { Ended: 'ended', Ringing: 'ringing' } },
  });
  calls.initializeCalls(client);
  return { calls, client, call, track, ownership, mediaHandler };
}

test('calls refuse an instance with call setup disabled and release media ownership', async () => {
  const { calls, ownership } = setup(false);
  await assert.rejects(calls.startCall('!dm:local', false), /enable calls/);
  assert.equal(calls.callSnapshot().call, null); assert.equal(ownership.mediaOwner(), null);
});

test('ignored callers are rejected before occupying the direct call panel or media session', () => {
  const { calls, client, call, ownership } = setup();
  call.getOpponentMember = () => ({ userId: '@blocked:local' }); client.getIgnoredUsers = () => ['@blocked:local'];
  let rejected = false; call.reject = () => { rejected = true; };
  client.emit('incoming', call);
  assert.equal(rejected, true); assert.equal(calls.callSnapshot().call, null); assert.equal(ownership.mediaOwner(), null);
  assert.equal(calls.callSnapshot().client, client); calls.resetCalls(); assert.equal(calls.callSnapshot().client, null);
});

test('push to talk starts with disabled audio tracks before placing the call', async () => {
  const { calls, call, track } = setup();
  await calls.setCallMediaSettings({ pushToTalk: true }); await calls.startCall('!dm:local', false);
  assert.equal(call.initialMuted, true); assert.equal(track.enabled, false); assert.equal(call.isMicrophoneMuted(), true);
});

test('releasing push to talk mutes synchronously and late signaling cannot unmute it', async () => {
  const { calls, call, track } = setup();
  await calls.startCall('!dm:local', false); await calls.setCallMediaSettings({ pushToTalk: true });
  const pending = []; call.send = () => new Promise(resolve => pending.push(resolve));
  const down = calls.setCallTalking(true); assert.equal(track.enabled, true);
  const up = calls.setCallTalking(false); assert.equal(track.enabled, false); assert.equal(call.isMicrophoneMuted(), true);
  pending[1](); await up; pending[0](); await down;
  assert.equal(track.enabled, false); assert.equal(call.isMicrophoneMuted(), true);
});

test('deafen immediately stops microphone and blocks push to talk even before settings finish', async () => {
  const { calls, call, track } = setup();
  await calls.startCall('!dm:local', false); await calls.setCallMediaSettings({ pushToTalk: true }); await calls.setCallTalking(true);
  const deafening = calls.setCallMediaSettings({ deafened: true }); assert.equal(track.enabled, false);
  await calls.setCallTalking(true); await deafening;
  assert.equal(track.enabled, false); assert.equal(call.isMicrophoneMuted(), true);
  await calls.setCallMediaSettings({ deafened: false }); assert.equal(track.enabled, false);
});

test('device failure preserves privacy mute and the next settings change still succeeds', async () => {
  const { calls, track, mediaHandler } = setup(); await calls.startCall('!dm:local', false);
  mediaHandler.setMediaInputs = async () => { throw new Error('Device unavailable'); };
  await assert.rejects(calls.setCallMediaSettings({ audioInput: 'missing', deafened: true }), /unavailable/);
  assert.equal(track.enabled, false); assert.equal(calls.callSnapshot().media.deafened, true);
  await calls.setCallMediaSettings({ outputVolume: 0.25 }); assert.equal(calls.callSnapshot().media.outputVolume, 0.25);
  await assert.rejects(calls.setCallMediaSettings({ outputVolume: NaN }), /volume/);
});

test('changing volume preserves a held microphone while disabling push to talk mutes it', async () => {
  const { calls, track } = setup(); await calls.startCall('!dm:local', false); await calls.setCallMediaSettings({ pushToTalk: true }); await calls.setCallTalking(true);
  await calls.setCallMediaSettings({ outputVolume: 0.5 }); assert.equal(track.enabled, true);
  await calls.setCallMediaSettings({ pushToTalk: false }); assert.equal(track.enabled, false);
});

test('conference media ownership blocks direct call capture', async () => {
  const { calls, ownership } = setup(); ownership.claimMedia('conference');
  await assert.rejects(calls.startCall('!dm:local', false), /current call/); assert.equal(ownership.mediaOwner(), 'conference');
});

test('logout during TURN discovery does not create a call or retain media ownership', async () => {
  const { calls, client, ownership } = setup(); let finish, created = false;
  client.checkTurnServers = () => new Promise(resolve => { finish = resolve; }); client.createCall = () => { created = true; };
  const starting = calls.startCall('!dm:local', false);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  calls.resetCalls(); finish(); await assert.rejects(starting, /canceled/);
  assert.equal(created, false); assert.equal(ownership.mediaOwner(), null); assert.equal(calls.callSnapshot().busy, false);
});

test('ending while microphone permission is pending stops the late stream without placing a call', async () => {
  const { calls, call, track, mediaHandler } = setup(); let finish;
  mediaHandler.getUserMediaStream = () => new Promise(resolve => { finish = () => resolve({ getAudioTracks: () => [track], getTracks: () => [track] }); });
  await calls.setCallMediaSettings({ pushToTalk: true }); const starting = calls.startCall('!dm:local', false);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  calls.endCall(); finish(); await assert.rejects(starting, /canceled/);
  assert.equal(track.stopped, true); assert.equal(call.initialMuted, undefined); assert.equal(calls.callSnapshot().call, null);
});

test('conference state survives minimization and ignores callbacks from an older connection', () => {
  const ownership = loadTs('../lib/media-session.ts', {}), session = loadTs('../lib/conference-session.ts', { './media-session': ownership });
  session.openConference('!voice:local'); const first = session.conferenceSnapshot().generation;
  session.conferenceJoined(first); session.minimizeConference();
  assert.equal(session.conferenceSnapshot().roomId, '!voice:local'); assert.equal(session.conferenceSnapshot().phase, 'joined'); assert.equal(ownership.mediaOwner(), 'conference');
  session.openConference('!voice:local'); assert.equal(session.conferenceSnapshot().minimized, false); assert.equal(session.conferenceSnapshot().generation, first);
  assert.throws(() => session.openConference('!other:local'), /current conference/);
  session.clearConference(first); session.openConference('!other:local');
  session.clearConference(first); session.conferenceFailed(first, 'late failure');
  assert.equal(session.conferenceSnapshot().roomId, '!other:local'); assert.equal(session.conferenceSnapshot().phase, 'joining'); assert.equal(ownership.mediaOwner(), 'conference');
});

test('failed conference releases media and retry creates a fresh connection generation', () => {
  const ownership = loadTs('../lib/media-session.ts', {}), session = loadTs('../lib/conference-session.ts', { './media-session': ownership });
  session.openConference('!voice:local'); const generation = session.conferenceSnapshot().generation;
  session.conferenceFailed(generation, 'TURN unavailable'); assert.equal(ownership.mediaOwner(), null);
  session.openConference('!voice:local'); assert.equal(session.conferenceSnapshot().generation, generation + 1); assert.equal(ownership.mediaOwner(), 'conference');
});
