import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { createConferenceOutputGate } = loadTs('../lib/conference-output.ts', {});
const track = (enabled = true) => ({ kind: 'audio', readyState: 'live', enabled });
test('deafen silences existing and newly received tracks and preserves each prior enabled state', () => {
  const gate = createConferenceOutputGate(), microphone = track(), share = track(), previouslyDisabled = track(false);
  gate.refresh([microphone, previouslyDisabled]); assert.equal(microphone.enabled, true);
  gate.set(true, [microphone, previouslyDisabled]); assert.equal(microphone.enabled, false);
  gate.refresh([microphone, share, previouslyDisabled]); assert.equal(share.enabled, false);
  gate.set(false, [microphone, share, previouslyDisabled]);
  assert.equal(microphone.enabled, true); assert.equal(share.enabled, true); assert.equal(previouslyDisabled.enabled, false);
});
test('reconnection and removal do not briefly restore a live receiver, while ended scope releases only its tracks', () => {
  const gate = createConferenceOutputGate(), first = track(), next = track(), unrelated = track();
  gate.set(true, [first]); gate.refresh([]); assert.equal(first.enabled, false);
  first.enabled = true; gate.refresh([next]); assert.equal(first.enabled, false); assert.equal(next.enabled, false); assert.equal(unrelated.enabled, true);
  gate.stop(); assert.equal(first.enabled, false); assert.equal(next.enabled, false); assert.equal(gate.read(), null);
  assert.throws(() => gate.set(true, [unrelated])); assert.equal(unrelated.enabled, true);
});
test('invalid track sets are rejected before changing playback intent', () => {
  const gate = createConferenceOutputGate(), video = { ...track(), kind: 'video' };
  assert.throws(() => gate.set(true, [video])); assert.equal(video.enabled, true); assert.equal(gate.read(), false);
  assert.throws(() => gate.set(true, Array.from({ length: 513 }, () => track()))); assert.equal(gate.read(), false);
});
