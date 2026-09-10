import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { createVoiceSidebarStore } = loadTs('../lib/voice-sidebar.ts', { './conference-session': { conferenceSnapshot: () => ({ roomId: null }), subscribeConference: () => () => {} } });

function fixture() {
  let active = { roomId: '!voice:local', generation: 1, phase: 'joining', minimized: false, error: '' }, valid = true;
  const events = new Set(), calls = [];
  const store = createVoiceSidebarStore(() => active, fn => { events.add(fn); return () => events.delete(fn); });
  const binding = () => ({ roomId: active.roomId, generation: active.generation, isCurrent: () => valid, setMicrophone: async value => { calls.push(['microphone', value]); }, disconnect: async () => { calls.push(['disconnect']); }, openSettings: () => { calls.push(['settings']); } });
  const bound = store.bind(binding());
  return { store, bound, calls, binding, change: patch => { active = { ...active, ...patch }; events.forEach(fn => fn()); }, retire: () => { valid = false; events.forEach(fn => fn()); } };
}
const peer = (deviceId = 'ONE', patch = {}) => ({ identity: deviceId, userId: '@guest:local', deviceId, displayName: 'Guest', avatarMxc: null, local: false, speaking: false, microphoneEnabled: false, cameraEnabled: false, screenShareEnabled: false, e2eeEnabled: true, encrypted: true, ...patch });
const observation = (participants, complete = true) => ({ connected: true, reconnecting: false, complete, participants, e2eeEnabled: true, metrics: { rttMs: 10, jitterMs: 1, packetLossPercent: 0, sampledTracks: 1, totalTracks: 1 } });

test('participant state uses only current native devices, with honest partial and unobservable flags', () => {
  const f = fixture();
  f.bound.update({ telemetry: observation([peer('OLD', { speaking: true }), peer('ONE')]) });
  const value = f.store.participant('!voice:local', '@guest:local', ['ONE']);
  assert.deepEqual(value, { speaking: false, muted: true, camera: false, sharing: false, deafened: null });
  assert.equal(f.store.participant('!other:local', '@guest:local', ['ONE']).muted, null);
  assert.equal(f.store.participant('!voice:local', '@guest:local', ['REPLACED']).speaking, null);
  assert.equal(f.store.participant('!voice:local', '@guest:local', ['ONE', 'TWO']).muted, null);
  f.bound.update({ telemetry: observation([peer('ONE', { speaking: true, microphoneEnabled: true, screenShareEnabled: true })], false) });
  const partial = f.store.participant('!voice:local', '@guest:local', ['ONE', 'TWO']);
  assert.equal(partial.speaking, true); assert.equal(partial.muted, false); assert.equal(partial.sharing, true); assert.equal(partial.camera, null);
  f.bound.update({ telemetry: null }); assert.equal(f.store.participant('!voice:local', '@guest:local', ['ONE']).speaking, null);
});

test('unrelated metrics and peer changes retain snapshot identity and never notify other room lists', () => {
  const f = fixture(); let other = 0, dock = 0;
  const offOther = f.store.subscribeRoom('!other:local', () => other++), offDock = f.store.subscribeDock(() => dock++);
  f.bound.update({ telemetry: observation([peer()]), devices: { audio_enabled: true }, ready: true });
  const initialDock = f.store.readDock(), initialPeer = f.store.participant('!voice:local', '@guest:local', ['ONE']);
  const updated = observation([peer(), { ...peer('OTHER', { speaking: true }), userId: '@other:local' }]); updated.metrics.rttMs = 100;
  f.bound.update({ telemetry: updated });
  assert.equal(f.store.readDock(), initialDock); assert.equal(f.store.participant('!voice:local', '@guest:local', ['ONE']), initialPeer);
  assert.equal(other, 0); assert.equal(dock, 1); offOther(); offDock();
});

test('dock connection comes from telemetry and microphone state changes only on actual device acknowledgement', async () => {
  const f = fixture(); f.change({ phase: 'joined' }); assert.equal(f.store.readDock().phase, 'unknown');
  await assert.rejects(f.store.microphone(f.store.readDock(), false), /no longer available/); assert.deepEqual(f.calls, []);
  f.bound.update({ telemetry: observation([peer()]), devices: { audio_enabled: true }, ready: true });
  const view = f.store.readDock(); await f.store.microphone(view, false);
  assert.equal(f.store.readDock().microphone, true); assert.equal(f.store.owns(view), true);
  f.bound.update({ devices: { audio_enabled: false } }); assert.equal(f.store.readDock().microphone, false);
  await assert.rejects(f.store.microphone(view, true), /no longer available/);
  f.store.action(f.store.readDock(), 'settings'); await f.store.action(f.store.readDock(), 'disconnect');
  assert.deepEqual(f.calls, [['microphone', false], ['settings'], ['disconnect']]);
});

test('retired owner and old disposal cannot publish into or control a replacement binding, including reused room/generation values', async () => {
  const f = fixture(); f.bound.update({ devices: { audio_enabled: true }, ready: true }); const old = f.store.readDock();
  f.retire(); assert.equal(f.store.readDock(), null); await assert.rejects(f.store.microphone(old, false));
  const replacement = f.store.bind({ ...f.binding(), isCurrent: () => true }); replacement.update({ devices: { audio_enabled: false }, ready: true });
  f.bound.update({ devices: { audio_enabled: true } }); f.bound.dispose();
  assert.equal(f.store.readDock().microphone, false); assert.equal(f.store.owns(old), false);
  assert.throws(() => f.store.action(old, 'disconnect')); assert.deepEqual(f.calls, []); replacement.dispose(); assert.equal(f.store.readDock(), null);
});

test('identical replacement snapshots still retire old action consent and a late microphone result cannot change the replacement', async () => {
  const f = fixture(), original = f.store.readDock();
  const replacement = f.store.bind(f.binding());
  assert.notEqual(f.store.readDock(), original); assert.equal(f.store.owns(original), false);
  assert.throws(() => f.store.action(original, 'disconnect'));
  let release;
  const pending = f.store.bind({ ...f.binding(), setMicrophone: () => new Promise(resolve => { release = resolve; }) });
  pending.update({ devices: { audio_enabled: true }, ready: true });
  const send = f.store.microphone(f.store.readDock(), false); assert.equal(f.store.readDock().busy, true);
  const next = f.store.bind(f.binding()); next.update({ devices: { audio_enabled: true }, ready: true });
  release(); await send; assert.equal(f.store.readDock().busy, false); assert.equal(f.store.readDock().microphone, true);
  replacement.dispose(); pending.dispose(); assert.notEqual(f.store.readDock(), null); next.dispose();
});
