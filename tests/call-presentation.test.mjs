import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadTs } from './load-ts.mjs';

const quality = loadTs('../lib/call-quality.ts', {});
const rows = (time, bytes, received, lost) => [
  { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' },
  { id: 'selected', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', currentRoundTripTime: 0.06, remoteCandidateId: 'remote' },
  { id: 'local', type: 'local-candidate', candidateType: 'relay', address: '192.0.2.10', port: 3478, url: 'turn:private-turn.example' },
  { id: 'remote', type: 'remote-candidate', candidateType: 'relay', address: '198.51.100.1' },
  { id: 'in', type: 'inbound-rtp', kind: 'audio', timestamp: time, bytesReceived: bytes, packetsReceived: received, packetsLost: lost, jitter: 0.004 },
  { id: 'out', type: 'outbound-rtp', kind: 'audio', timestamp: time, bytesSent: bytes / 2 },
];
test('call measurements use actual interval deltas and retain no candidate addresses', () => {
  const first = quality.projectCallQuality(rows(1000, 100000, 100, 0));
  assert.equal(first.quality.downloadKbps, null); assert.equal(first.quality.receiveLossPercent, null);
  const second = quality.projectCallQuality(rows(3000, 200000, 196, 4), first.counters, 'connected', 'completed');
  assert.equal(second.quality.downloadKbps, 400); assert.equal(second.quality.uploadKbps, 200); assert.equal(second.quality.receiveLossPercent, 4);
  assert.equal(second.quality.roundTripMs, 60); assert.equal(second.quality.jitterMs, 4); assert.equal(second.quality.localRoute, 'relay');
  const encoded = JSON.stringify([second.quality, [...second.counters]]);
  for (const secret of ['192.0.2', '198.51.100', 'private-turn', '3478']) assert.ok(!encoded.includes(secret));
});
test('counter resets, stale intervals and missing metrics remain unavailable', () => {
  const first = quality.projectCallQuality(rows(1000, 100000, 100, 5));
  const reset = quality.projectCallQuality(rows(3000, 10, 1, 0), first.counters);
  assert.equal(reset.quality.downloadKbps, null); assert.equal(reset.quality.receiveLossPercent, null);
  const stale = quality.projectCallQuality(rows(20000, 200000, 200, 10), first.counters); assert.equal(stale.quality.downloadKbps, null);
  const absent = quality.projectCallQuality(undefined); assert.equal(absent.quality.available, false); assert.equal(absent.quality.roundTripMs, null); assert.equal(absent.quality.localRoute, null);
  const malformed = quality.projectCallQuality([{ id: 'in', type: 'inbound-rtp', timestamp: 1000, bytesReceived: NaN, jitter: -1 }, { type: 'candidate-pair', selected: true, currentRoundTripTime: Infinity }]);
  assert.equal(malformed.quality.jitterMs, null); assert.equal(malformed.quality.roundTripMs, null);
});
test('ambiguous candidate pairs are not presented as a verified relay route', () => {
  const ambiguous = rows(1000, 100000, 100, 0).filter(row => row.type !== 'transport');
  ambiguous[0].nominated = true;
  ambiguous.push({ id: 'other', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', currentRoundTripTime: 0.5 });
  assert.equal(quality.projectCallQuality(ambiguous).quality.localRoute, null);
});
test('direct-call status requires a connected peer and observed relay, with truthful failure and recovery', () => {
  const project = (connection, ice, raw = rows(1000, 1000, 1, 0)) => quality.projectCallQuality(raw, new Map(), connection, ice, 'complete').quality;
  assert.equal(quality.callConnectionPresentation(null).label, 'Connecting media…');
  const failed = project('failed', 'disconnected');
  assert.equal(quality.callConnectionPresentation(failed).label, 'Connection failed');
  assert.match(quality.callConnectionPresentation(failed).guidance, /successful allocation alone does not confirm/);
  assert.equal(quality.callConnectionPresentation(project('connected', 'disconnected')).label, 'Media disconnected');
  assert.equal(quality.callConnectionPresentation(project('connected', 'connected', [])).label, 'Connected · Relay route not confirmed');
  assert.equal(quality.callConnectionPresentation(project('connected', 'completed')).label, 'Connected · Relayed encrypted media');
  assert.equal(failed.localCandidates, 1); assert.equal(failed.localRelayCandidates, 1); assert.equal(failed.remoteCandidates, 1); assert.equal(failed.gathering, 'complete');
  const duplicate = project('failed', 'failed', [...rows(1000, 1, 1, 0), ...rows(1000, 1, 1, 0)]);
  assert.equal(duplicate.localRelayCandidates, 1, 'A repeated report ID is counted once');
  assert.equal(quality.projectCallQuality(Array.from({ length: 2001 }, (_, i) => ({ id: String(i), type: 'local-candidate', candidateType: 'relay' }))).quality.localRelayCandidates, null, 'A truncated report must not claim a complete candidate count');
  assert.equal(quality.projectCallQuality(undefined).quality.localRelayCandidates, null);
});
test('peer replacement retires a pending report and native state changes update without a second stats poll', async () => {
  const peer = state => Object.assign(new EventTarget(), { connectionState: state, iceConnectionState: state, iceGatheringState: 'complete' });
  const old = peer('connected'), replacement = peer('connecting'), values = []; let complete, reads = 0;
  const call = { peerConn: old, getCurrentCallStats: () => { reads++; return new Promise(resolve => { complete = resolve; }); } };
  const stop = quality.watchCallQuality(call, value => values.push(value), 1000);
  call.peerConn = replacement; complete(rows(1000, 1, 1, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(values.at(-1).connection, 'connecting'); assert.equal(values.at(-1).localRoute, null);
  old.connectionState = 'failed'; old.dispatchEvent(new Event('connectionstatechange')); assert.equal(values.at(-1).connection, 'connecting');
  replacement.connectionState = 'failed'; replacement.dispatchEvent(new Event('connectionstatechange')); assert.equal(values.at(-1).connection, 'failed'); assert.equal(reads, 1);
  stop(); const count = values.length; replacement.dispatchEvent(new Event('connectionstatechange')); assert.equal(values.length, count);
});
test('stopping call measurements ignores a pending report and schedules no more work', async () => {
  let complete; const values = [];
  const call = { peerConn: { connectionState: 'connected', iceConnectionState: 'connected' }, getCurrentCallStats: () => new Promise(resolve => { complete = resolve; }) };
  const stop = quality.watchCallQuality(call, value => values.push(value), 5); stop(); complete(rows(1000, 1, 1, 0));
  await new Promise(resolve => setTimeout(resolve, 15)); assert.deepEqual(values, []);
});
test('speech activity shares the existing SDK feed analyser and respects mute and cleanup', () => {
  const events = { VolumeChanged: 'volume', Speaking: 'speaking', MuteStateChanged: 'mute', NewStream: 'stream', Disposed: 'disposed' };
  const api = loadTs('../lib/call-presentation.ts', { 'matrix-js-sdk/lib/webrtc/callFeed': { CallFeedEvent: events } });
  const feed = new EventEmitter(); let muted = false, speaking = true; const measure = [];
  Object.assign(feed, { purpose: 'm.usermedia', hasAudioTrack: true, isAudioMuted: () => muted, isSpeaking: () => speaking, measureVolumeActivity: enabled => measure.push(enabled) });
  const left = [], right = [], stopLeft = api.watchSpeechActivity(feed, value => left.push(value)), stopRight = api.watchSpeechActivity(feed, value => right.push(value));
  assert.deepEqual(measure, [true]); feed.emit('volume', -30); assert.equal(left.at(-1).level, 50); assert.equal(right.at(-1).speaking, true);
  muted = true; feed.emit('mute'); assert.equal(left.at(-1).speaking, false); assert.equal(left.at(-1).level, 0);
  stopLeft(); assert.deepEqual(measure, [true]); stopRight(); assert.deepEqual(measure, [true, false]); assert.equal(feed.listenerCount('volume'), 0);
  feed.purpose = 'm.screenshare'; const sharedAudio = []; api.watchSpeechActivity(feed, value => sharedAudio.push(value))();
  assert.deepEqual(measure, [true, false]); assert.equal(sharedAudio[0].measured, false, 'Shared system audio is not labelled as a speaking participant');
});
