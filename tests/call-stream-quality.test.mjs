import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadTs } from './load-ts.mjs';

const sdk = { CallEvent: { FeedsChanged: 'feeds_changed', PeerConnectionCreated: 'peer_created', State: 'state', Hangup: 'hangup' }, CallFeedEvent: { NewStream: 'new_stream', MuteStateChanged: 'mute_state_changed' } };
const { CallStreamQualityController } = loadTs('../lib/call-stream-quality.ts', { 'matrix-js-sdk': sdk });
const copy = value => structuredClone(value);
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) { for (let count = 0; count < 30; count++) { if (predicate()) return; await turn(); } assert.fail('Expected queued browser operation did not start'); }

class Track extends EventTarget {
  kind = 'video'; readyState = 'live'; enabled = false; stopped = 0; writes = [];
  constraints = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 }, deviceId: { exact: 'private-camera-id' }, facingMode: 'user', advanced: [{ resizeMode: 'crop-and-scale' }] };
  settings = { width: 640, height: 360, frameRate: 24, deviceId: 'private-camera-id', groupId: 'private-group-id' };
  getSettings() { return copy(this.settings); }
  getConstraints() { return copy(this.constraints); }
  async applyConstraints(value) { this.writes.push(copy(value)); if (this.beforeApply) await this.beforeApply(value); this.constraints = copy(value); for (const key of ['width', 'height', 'frameRate']) this.settings[key] = typeof value[key] === 'object' ? value[key].max ?? value[key].ideal : value[key] ?? this.settings[key]; }
  stop() { this.stopped++; this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}
class Sender {
  writes = []; reads = 0;
  constructor(track, encodings = [{ active: false, scaleResolutionDownBy: 2 }]) { this.track = track; this.parameters = { transactionId: '0', codecs: [{ mimeType: 'video/VP8', payloadType: 96 }], headerExtensions: [{ id: 1, uri: 'header' }], rtcp: { cname: 'private-cname', reducedSize: true }, encodings: copy(encodings) }; }
  getParameters() { this.parameters.transactionId = String(++this.reads); return copy(this.parameters); }
  async setParameters(value) { assert.equal(value.transactionId, String(this.reads), 'setParameters must use its latest transaction'); this.writes.push(copy(value)); if (this.beforeSet) await this.beforeSet(value); if (!this.ignore) this.parameters = copy(value); }
}
function fixture({ camera = new Track(), screen, encodings } = {}) {
  const call = new EventEmitter(), audio = new Track(), remote = new Track(); audio.kind = 'audio';
  const cameraSender = camera && new Sender(camera, encodings), screenSender = screen && new Sender(screen), audioSender = new Sender(audio), remoteSender = new Sender(remote);
  const senders = [cameraSender, screenSender, audioSender, remoteSender].filter(Boolean);
  const stream = track => ({ getVideoTracks: () => track ? [track] : [] });
  Object.assign(call, { state: 'connected', localUsermediaStream: stream(camera), localScreensharingStream: stream(screen), localUsermediaFeed: new EventEmitter(), localScreensharingFeed: screen ? new EventEmitter() : undefined, peerConn: { signalingState: 'stable', getSenders: () => senders } });
  let current = true;
  const controller = new CallStreamQualityController(call, () => current);
  return { call, camera, screen, cameraSender, screenSender, audio, remote, audioSender, remoteSender, senders, controller, setCurrent: value => { current = value; }, stream };
}

test('default settings only measure; presets change exact owned video while preserving device, mute and RTP controls', async () => {
  const f = fixture(); await turn();
  assert.equal(f.camera.writes.length, 0); assert.equal(f.cameraSender.writes.length, 0);
  const original = copy(f.camera.constraints), result = await f.controller.set('camera', 'low');
  assert.equal(result.status, 'applied'); assert.equal(result.capture.width, 640);
  assert.equal(f.camera.constraints.deviceId.exact, 'private-camera-id'); assert.deepEqual(f.camera.constraints.advanced, original.advanced); assert.equal(f.camera.constraints.facingMode, 'user');
  const parameters = f.cameraSender.writes.at(-1);
  assert.deepEqual(parameters.encodings, [{ active: false, scaleResolutionDownBy: 2, maxBitrate: 500000, maxFramerate: 15 }]);
  assert.deepEqual(parameters.codecs, [{ mimeType: 'video/VP8', payloadType: 96 }]); assert.deepEqual(parameters.headerExtensions, [{ id: 1, uri: 'header' }]); assert.equal(parameters.rtcp.cname, 'private-cname');
  assert.equal(f.camera.enabled, false); assert.equal(f.camera.stopped, 0);
  for (const untouched of [f.audio, f.remote, f.audioSender, f.remoteSender]) assert.equal(untouched.writes.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-camera|private-group|private-cname|deviceId|transactionId|codecs/);
  await f.controller.set('camera', 'automatic');
  assert.deepEqual(f.camera.constraints, original); assert.deepEqual(f.cameraSender.parameters.encodings, [{ active: false, scaleResolutionDownBy: 2 }]);
  f.controller.dispose();
});

test('restoration retains intervening owner changes and keeps existing tighter sender limits', async () => {
  const f = fixture({ encodings: [{ active: true, maxBitrate: 100000, maxFramerate: 10 }] }); await turn();
  await f.controller.set('camera', 'detail');
  assert.equal(f.cameraSender.parameters.encodings[0].maxBitrate, 100000); assert.equal(f.cameraSender.parameters.encodings[0].maxFramerate, 10);
  f.camera.constraints.width = { ideal: 800 }; f.camera.constraints.facingMode = 'environment';
  f.cameraSender.parameters.encodings[0].maxBitrate = 80000; f.cameraSender.parameters.encodings[0].active = false;
  await f.controller.set('camera', 'low'); await f.controller.set('camera', 'automatic');
  assert.deepEqual(f.camera.constraints.width, { ideal: 800 }); assert.equal(f.camera.constraints.facingMode, 'environment');
  assert.equal(f.cameraSender.parameters.encodings[0].maxBitrate, 80000); assert.equal(f.cameraSender.parameters.encodings[0].active, false);
  f.controller.dispose();
});

test('rapid requests serialize capture and preserve the original baseline after a superseded browser completion', async () => {
  const f = fixture(); await turn(); const original = copy(f.camera.constraints), gate = deferred();
  f.camera.beforeApply = () => gate.promise;
  const low = f.controller.set('camera', 'low'); await until(() => f.camera.writes.length === 1);
  const detail = f.controller.set('camera', 'detail'); await turn(); assert.equal(f.camera.writes.length, 1);
  f.camera.beforeApply = undefined; gate.resolve(); assert.equal(await low, null); assert.equal((await detail).preset, 'detail');
  assert.equal(f.cameraSender.writes.length, 1); assert.equal(f.cameraSender.writes[0].encodings[0].maxBitrate, 3000000);
  await f.controller.set('camera', 'automatic'); assert.deepEqual(f.camera.constraints, original);
  f.controller.dispose();
});

test('rapid sender requests use fresh transactions and restore before either preset rather than the superseded cap', async () => {
  const f = fixture(); await turn(); const gate = deferred(); f.cameraSender.beforeSet = () => gate.promise;
  const low = f.controller.set('camera', 'low'); await until(() => f.cameraSender.writes.length === 1);
  const balanced = f.controller.set('camera', 'balanced'); await turn(); assert.equal(f.cameraSender.writes.length, 1);
  f.cameraSender.beforeSet = undefined; gate.resolve(); assert.equal(await low, null); await balanced;
  assert.equal(f.cameraSender.parameters.encodings[0].maxBitrate, 1500000);
  await f.controller.set('camera', 'automatic'); assert.equal(f.cameraSender.parameters.encodings[0].maxBitrate, undefined); assert.equal(f.cameraSender.parameters.encodings[0].maxFramerate, undefined);
  f.controller.dispose();
});

test('call, track, peer and sender replacement abort late follow-up writes and late publication', async () => {
  for (const change of ['call', 'track', 'peer', 'sender']) {
    const f = fixture(); await turn(); const gate = deferred(), snapshots = []; const off = f.controller.subscribe(value => snapshots.push(value));
    if (change === 'sender') f.cameraSender.beforeSet = () => gate.promise; else f.camera.beforeApply = () => gate.promise;
    const work = f.controller.set('camera', 'low'); await until(() => change === 'sender' ? f.cameraSender.writes.length === 1 : f.camera.writes.length === 1);
    const count = snapshots.length, replacement = new Track();
    if (change === 'call') f.setCurrent(false);
    else if (change === 'track') f.call.localUsermediaStream = f.stream(replacement);
    else if (change === 'peer') f.call.peerConn = { signalingState: 'stable', getSenders: () => [new Sender(replacement)] };
    else f.cameraSender.track = replacement;
    gate.resolve(); assert.equal(await work, null); assert.equal(snapshots.length, count); assert.equal(replacement.writes.length, 0);
    if (change !== 'sender') assert.equal(f.cameraSender.writes.length, 0);
    off(); f.controller.dispose();
  }
});

test('browser reordering of equivalent constraint fields cannot replace the restoration baseline', async () => {
  const f = fixture(); await turn(); const original = copy(f.camera.constraints);
  const read = f.camera.getConstraints.bind(f.camera);
  f.camera.getConstraints = () => { const value = read(); for (const key of ['width', 'height', 'frameRate']) if (value[key] && typeof value[key] === 'object') value[key] = Object.fromEntries(Object.entries(value[key]).reverse()); return value; };
  await f.controller.set('camera', 'low'); await f.controller.set('camera', 'automatic');
  assert.deepEqual(f.camera.constraints, original); f.controller.dispose();
});

test('silently ignored capture constraints are reported even when actual pixels fit within the requested maximum', async () => {
  const f = fixture(); await turn();
  f.camera.applyConstraints = async value => { f.camera.writes.push(copy(value)); };
  const result = await f.controller.set('camera', 'detail');
  assert.equal(result.status, 'partial'); assert.equal(result.captureOutcome, 'unsupported'); assert.equal(result.capture.width, 640); assert.equal(result.senderOutcome, 'applied');
  assert.match(result.messages.join(' '), /did not retain the requested capture/); f.controller.dispose();
});

test('camera and screen writes share a queue but stay on their distinct owned tracks', async () => {
  const f = fixture({ screen: new Track() }); await turn(); const gate = deferred(); f.camera.beforeApply = () => gate.promise;
  const cameraWork = f.controller.set('camera', 'low'); await until(() => f.camera.writes.length === 1);
  const screenWork = f.controller.set('screen', 'text'); await turn(); assert.equal(f.screen.writes.length, 0);
  gate.resolve(); await cameraWork; await screenWork;
  assert.equal(f.cameraSender.parameters.encodings[0].maxBitrate, 500000); assert.equal(f.screenSender.parameters.encodings[0].maxBitrate, 2500000);
  assert.equal(f.screen.constraints.frameRate.max, 15); f.controller.dispose();
});

test('multiple senders and simulcast encodings share the total budget without altering their topology', async () => {
  const f = fixture({ encodings: [{ rid: 'low', active: false, scaleResolutionDownBy: 4 }, { rid: 'high', active: true, scaleResolutionDownBy: 1 }] });
  const duplicate = new Sender(f.camera, [{ rid: 'another', active: true }]); f.senders.push(duplicate); await turn();
  const result = await f.controller.set('camera', 'low');
  assert.equal(result.limits.reduce((sum, value) => sum + value.maxBitrate, 0), 500000);
  assert.equal(f.cameraSender.parameters.encodings.length, 2); assert.deepEqual(f.cameraSender.parameters.encodings.map(({ rid, active, scaleResolutionDownBy }) => ({ rid, active, scaleResolutionDownBy })), [{ rid: 'low', active: false, scaleResolutionDownBy: 4 }, { rid: 'high', active: true, scaleResolutionDownBy: 1 }]);
  f.controller.dispose();
});

test('unavailable sources wait without capture; a newly owned source and later negotiated sender receive the selected preset', async () => {
  const f = fixture({ camera: null }); await turn(); const waiting = await f.controller.set('screen', 'text');
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.available, false);
  const screen = new Track(), sender = new Sender(screen, []); f.senders.push(sender); f.call.localScreensharingStream = f.stream(screen); f.call.localScreensharingFeed = new EventEmitter();
  f.call.emit('feeds_changed'); await until(() => f.controller.getSnapshot().screen.senderOutcome === 'waiting' && screen.writes.length === 1);
  sender.parameters.encodings = [{ active: true }]; f.call.emit('state');
  await until(() => f.controller.getSnapshot().screen.status === 'applied'); assert.equal(sender.parameters.encodings[0].maxBitrate, 2500000);
  assert.equal(f.audio.writes.length, 0); f.controller.dispose();
});

test('partial, unsupported and browser-ignored changes remain explicit instead of claiming requested capture', async () => {
  const f = fixture(); await turn();
  f.camera.beforeApply = () => { throw Object.assign(new Error('private device details'), { name: 'OverconstrainedError' }); };
  const partial = await f.controller.set('camera', 'low'); assert.equal(partial.status, 'partial'); assert.equal(partial.captureOutcome, 'failed'); assert.equal(partial.senderOutcome, 'applied'); assert.equal(partial.capture.frameRate, 24); assert.doesNotMatch(JSON.stringify(partial), /private device/);
  f.camera.beforeApply = undefined; f.cameraSender.ignore = true;
  const ignored = await f.controller.set('camera', 'detail'); assert.equal(ignored.status, 'partial'); assert.equal(ignored.senderOutcome, 'unsupported'); assert.equal(ignored.limits[0].maxBitrate, 500000);
  f.camera.applyConstraints = undefined; f.cameraSender.setParameters = undefined;
  const unsupported = await f.controller.set('camera', 'balanced'); assert.equal(unsupported.status, 'unsupported');
  f.controller.dispose();
});

test('unmount, remount and ending the call preserve media ownership and the call baseline', async () => {
  const f = fixture(); await turn(); const original = copy(f.camera.constraints);
  await f.controller.set('camera', 'low'); f.controller.dispose();
  assert.equal(f.call.listenerCount('feeds_changed'), 0); assert.equal(f.call.localUsermediaFeed.listenerCount('new_stream'), 0); assert.equal(f.camera.stopped, 0); assert.equal(f.camera.enabled, false);
  const next = new CallStreamQualityController(f.call, () => true); await turn(); assert.equal(next.getSnapshot().camera.preset, 'low');
  await next.set('camera', 'automatic'); assert.deepEqual(f.camera.constraints, original);
  f.call.state = 'ended'; f.call.emit('hangup'); await assert.rejects(next.set('camera', 'low'), /no longer active/);
  assert.equal(f.call.listenerCount('feeds_changed'), 0); assert.equal(f.camera.stopped, 0);
});

test('ambiguous or ended owned video tracks are never modified', async () => {
  const f = fixture(); await turn(); const other = new Track();
  f.call.localUsermediaStream = { getVideoTracks: () => [f.camera, other] }; f.call.emit('feeds_changed');
  assert.equal((await f.controller.set('camera', 'low')).status, 'waiting'); assert.equal(f.camera.writes.length, 0); assert.equal(other.writes.length, 0);
  f.call.localUsermediaStream = f.stream(f.camera); f.camera.stop();
  assert.equal((await f.controller.set('camera', 'balanced')).status, 'waiting'); assert.equal(f.camera.writes.length, 0);
  await assert.rejects(f.controller.set('remote', 'low'), /supported/); await assert.rejects(f.controller.set('camera', '__proto__'), /supported/);
  f.controller.dispose();
});
