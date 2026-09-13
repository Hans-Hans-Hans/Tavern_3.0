import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const audio = loadTs('../lib/audio-processing.ts', {});
const tick = () => new Promise(resolve => setImmediate(resolve));
function microphone() {
  let constraints = { deviceId: { exact: 'private-device' }, sampleRate: 48000 }, settings = { deviceId: 'private-device', groupId: 'private-group' };
  return { kind: 'audio', readyState: 'live', enabled: false, writes: [], getConstraints: () => constraints, getSettings: () => settings,
    async applyConstraints(next) { this.writes.push(next); if (this.wait) await this.wait(); constraints = next; for (const key of audio.audioProcessingKeys) if (next[key]) settings[key] = next[key].ideal; } };
}
test('speech processing uses the existing muted microphone and reports only confirmed processing fields', async () => {
  const track = microphone(), reports = [], controller = new audio.MicrophoneProcessingController(() => true, () => audio.speechProcessing, value => reports.push(value));
  controller.refresh(track, audio.speechProcessing); await tick();
  assert.equal(track.writes.length, 1); assert.equal(track.writes[0].sampleRate, 48000); assert.equal(track.enabled, false);
  assert.deepEqual(reports.at(-1), { state: 'applied', ...audio.speechProcessing }); assert.doesNotMatch(JSON.stringify(reports), /private-device|private-group/);
  controller.refresh(track, audio.speechProcessing); await tick(); assert.equal(track.writes.length, 1);
  controller.dispose();
});
test('music and replacement microphones retain echo cancellation and leave non-audio tracks alone', async () => {
  const first = microphone(), replacement = microphone(), reports = [], controller = new audio.MicrophoneProcessingController(() => true, () => audio.speechProcessing, value => reports.push(value));
  controller.refresh(first, audio.musicProcessing); await tick();
  assert.deepEqual(reports.at(-1), { state: 'applied', ...audio.musicProcessing });
  controller.refresh(replacement, audio.musicProcessing); await tick(); assert.deepEqual(replacement.writes[0].echoCancellation, { ideal: true }); assert.equal(replacement.enabled, false);
  const camera = { kind: 'video', readyState: 'live', applyConstraints() { throw new Error('Unexpected camera mutation'); } };
  controller.refresh(camera, audio.speechProcessing); await tick(); assert.equal(reports.at(-1).state, 'waiting'); controller.dispose();
});
test('a stalled old microphone does not block its replacement or publish stale results', async () => {
  const old = microphone(), next = microphone(), reports = []; let release; old.wait = () => new Promise(resolve => release = resolve);
  const controller = new audio.MicrophoneProcessingController(() => true, () => audio.speechProcessing, value => reports.push(value));
  controller.refresh(old, audio.speechProcessing); await tick(); controller.refresh(next, audio.musicProcessing); await tick();
  assert.deepEqual(reports.at(-1), { state: 'applied', ...audio.musicProcessing }); const count = reports.length;
  release(); await tick(); assert.equal(reports.length, count); controller.dispose();
});
test('preference changes on one track are serialized and retired owners cannot apply queued settings', async () => {
  const track = microphone(), reports = []; let release, owned = true; track.wait = () => new Promise(resolve => release = resolve);
  const controller = new audio.MicrophoneProcessingController(() => owned, () => audio.speechProcessing, value => reports.push(value));
  controller.refresh(track, audio.speechProcessing); await tick(); controller.refresh(track, audio.musicProcessing); owned = false;
  release(); await tick(); assert.equal(track.writes.length, 1); assert.equal(reports.at(-1).state, 'applying'); controller.dispose();
});
test('unsupported and failed processing is never presented as confirmed', async () => {
  const track = microphone(), reports = [], controller = new audio.MicrophoneProcessingController(() => true, () => ({}), value => reports.push(value));
  controller.refresh(track, audio.speechProcessing); await tick(); assert.equal(reports.at(-1).state, 'partial'); assert.equal(track.writes.length, 0); controller.dispose();
  track.applyConstraints = async () => { throw new Error('private device failed'); };
  const failing = new audio.MicrophoneProcessingController(() => true, () => audio.speechProcessing, value => reports.push(value));
  failing.refresh(track, audio.speechProcessing); await tick(); assert.deepEqual(reports.at(-1), { ...audio.emptyAudioProcessingReport(), state: 'failed' }); failing.dispose();
});
test('audio preferences validate saved booleans and propagate same-document updates without opening media', () => {
  const host = new EventTarget(); let saved = '{"noiseSuppression":"false","echoCancellation":false,"autoGainControl":9}';
  host.localStorage = { getItem: () => saved, setItem: (_, value) => saved = value };
  assert.deepEqual(audio.readAudioProcessing(host), { noiseSuppression: true, echoCancellation: false, autoGainControl: true });
  let updates = 0; const off = audio.subscribeAudioProcessing(() => updates++, host);
  audio.saveAudioProcessing(audio.musicProcessing, host); assert.equal(updates, 1); assert.deepEqual(audio.readAudioProcessing(host), audio.musicProcessing);
  assert.throws(() => audio.saveAudioProcessing({ noiseSuppression: 'yes' }, host), /valid/); off();
});
