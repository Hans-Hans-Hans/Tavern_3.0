import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { createCallIdleTimer, leaveIdleConference, idleConferenceEnded, monitorCallInteraction } = loadTs('../lib/call-idle.ts', {});
function fixture() { let now = 0, expired = 0; const warnings = []; return { timer: createCallIdleTimer(300, value => warnings.push(value), () => expired++, () => now), advance: value => { now += value; }, warnings, expired: () => expired }; }
test('inactivity warns before expiry and leave callback runs only once', () => {
  const f = fixture(); f.advance(269000); f.timer.check(); assert.deepEqual(f.warnings, []);
  f.advance(1000); f.timer.check(); assert.deepEqual(f.warnings, [30]);
  f.advance(29000); f.timer.check(); assert.equal(f.warnings.at(-1), 1); assert.equal(f.expired(), 0);
  f.advance(1000); f.timer.check(); f.timer.check(); f.timer.activity(); f.advance(300000); f.timer.check(); assert.equal(f.expired(), 1);
});
test('interaction clears the warning and starts a fresh idle interval', () => {
  const f = fixture(); f.advance(280000); f.timer.check(); f.timer.activity(); assert.equal(f.warnings.at(-1), null);
  f.advance(20000); f.timer.check(); assert.equal(f.expired(), 0); f.advance(250000); f.timer.check(); assert.equal(f.warnings.at(-1), 30);
});
test('a suspended browser receives a new warning interval and stopped generations cannot expire', () => {
  const f = fixture(); f.advance(3600000); f.timer.check(); assert.equal(f.expired(), 0); assert.equal(f.warnings.at(-1), 30);
  f.timer.stop(); f.advance(30000); f.timer.check(); assert.equal(f.expired(), 0);
});
test('invalid idle durations never start a monitor', () => {
  for (const duration of [0, -1, 59, 3601, NaN, Infinity]) assert.throws(() => createCallIdleTimer(duration, () => {}, () => {}), /timeout/);
});
test('expiry checks authoritative room, generation and joined phase before touching the captured close', async () => {
  let state = { roomId: '!old', generation: 1, phase: 'joined' }, closed = 0;
  const close = async () => { closed++; state = { ...state, phase: 'idle', roomId: null }; return true; };
  for (const replacement of [{ roomId: '!new', generation: 2, phase: 'joined' }, { roomId: '!other', generation: 1, phase: 'joined' }, { roomId: '!old', generation: 1, phase: 'closing' }]) {
    state = replacement; assert.equal(await leaveIdleConference('!old', 1, close, () => state), false);
  }
  state = { roomId: '!old', generation: 1, phase: 'joined' }; assert.equal(await leaveIdleConference('!old', 1, null, () => state), false); assert.equal(closed, 0);
  assert.equal(await leaveIdleConference('!old', 1, close, () => state), true); assert.equal(closed, 1);
});
test('late leave resolution never authorizes a handoff for a newer call or a cleanup that did not confirm leaving', async () => {
  let state = { roomId: '!old', generation: 1, phase: 'joined' }, complete;
  const pending = leaveIdleConference('!old', 1, () => new Promise(resolve => { complete = resolve; }), () => state);
  state = { roomId: '!new', generation: 2, phase: 'joined' }; complete(true); assert.equal(await pending, false); assert.equal(idleConferenceEnded(1, () => state), false);
  state = { roomId: '!old', generation: 1, phase: 'joined' }; assert.equal(await leaveIdleConference('!old', 1, async () => false, () => state), false);
  assert.equal(await leaveIdleConference('!old', 1, async () => true, () => state), false);
});
test('frame reload detaches the old document and final cleanup releases every listener', () => {
  class Target { listeners = new Map(); addEventListener(name, fn) { this.listeners.set(name, fn); } removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); } }
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  const page = new Target(), first = new Target(), second = new Target(), frame = new Target(); frame.contentDocument = first;
  globalThis.document = page; let intervalCleared = false; globalThis.window = { setInterval: () => 7, clearInterval: id => { assert.equal(id, 7); intervalCleared = true; } };
  try {
    const stop = monitorCallInteraction(frame, 300, () => {}, () => {}); assert.equal(first.listeners.size, 5); assert.equal(page.listeners.size, 5);
    frame.contentDocument = second; frame.listeners.get('load')(); assert.equal(first.listeners.size, 0); assert.equal(second.listeners.size, 5);
    Object.defineProperty(frame, 'contentDocument', { get() { throw new Error('Cross-origin navigation'); } }); frame.listeners.get('load')(); assert.equal(second.listeners.size, 0);
    stop(); assert.equal(page.listeners.size, 0); assert.equal(frame.listeners.size, 0); assert.equal(intervalCleared, true);
  } finally { globalThis.document = oldDocument; globalThis.window = oldWindow; }
});
