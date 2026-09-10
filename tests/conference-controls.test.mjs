import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadTs } from './load-ts.mjs';
globalThis.location = { origin: 'https://tavern.test' };

function setup() {
  let api;
  class WidgetApi extends EventEmitter {
    constructor() { super(); api = this; this.controls = { audio_enabled: true, video_enabled: false }; this.transport = { reply: async () => {}, send: async (action, patch) => { this.lastAction = action; if (action === 'io.element.device_mute' && !this.unavailable) Object.assign(this.controls, patch); return this.controls; } }; }
    setViewedRoomId() {}
    stop() { this.stopped = true; }
  }
  const enums = new Proxy({}, { get: (_target, key) => String(key) });
  const conference = loadTs('../lib/conference.ts', {
    './matrix-media': loadTs('../lib/matrix-media.ts', {}),
    './conference-url': loadTs('../lib/conference-url.ts', {}),
    './conference-telemetry': { observeConferenceTelemetry: () => () => {} },
    './media-session': { claimMedia() {}, releaseMedia() {} },
    'matrix-js-sdk': { ClientEvent: enums, EventType: enums, MatrixEventEvent: enums, RoomEvent: enums, RoomStateEvent: enums },
    'matrix-widget-api': { ClientWidgetApi: WidgetApi, Widget: class {}, WidgetDriver: class {}, WidgetEventCapability: {}, EventDirection: {}, MatrixCapabilities: {}, OpenIDRequestState: {} },
  });
  const client = new EventEmitter(); Object.assign(client, { getRoom: () => ({ loadMembersIfNeeded: async () => {}, currentState: { maySendStateEvent: () => true } }), getCrypto: () => ({ isEncryptionEnabledInRoom: async () => true }), _unstable_getRTCTransports: async () => [{}], getUserId: () => '@me:local', getDeviceId: () => 'DEVICE', getHomeserverUrl: () => 'https://tavern.test' });
  return { conference, client, api: () => api };
}

test('conference dock uses native widget controls and reports confirmed device state', async () => {
  const { conference, client, api } = setup(), reported = [], iframe = { src: '' };
  const controls = await conference.mountConference(client, '!room:local', iframe, () => {}, undefined, undefined, true, value => reported.push(value));
  await controls.setDevices({ audio_enabled: false });
  assert.equal(api().lastAction, 'io.element.device_mute'); assert.equal(reported.at(-1).audio_enabled, false);
  api().emit('action:io.element.device_mute', { preventDefault() {}, detail: { data: { audio_enabled: true, video_enabled: 'invalid', secret: 'ignored' } } });
  assert.deepEqual(reported.at(-1), { audio_enabled: true });
  await controls(); assert.equal(api().stopped, true); assert.equal(iframe.src, 'about:blank');
  await assert.rejects(controls.setDevices({ audio_enabled: true }), /ended/);
});

test('unsupported device change is not reported as successful and old cleanup preserves a new frame', async () => {
  const { conference, client, api } = setup(), iframe = { src: '' };
  const controls = await conference.mountConference(client, '!room:local', iframe, () => {}, undefined, undefined, true);
  api().unavailable = true;
  await assert.rejects(controls.setDevices({ video_enabled: true }), /still preparing/);
  iframe.src = 'https://tavern.test/element-call/index.html#new-session';
  await controls(); assert.equal(iframe.src, 'https://tavern.test/element-call/index.html#new-session');
});

test('embedded version discovery uses the public native URL while the authenticated driver stays on its managed client', async () => {
  const { conference, client } = setup(), iframe = { src: '' };
  client.getHomeserverUrl = () => 'https://tavern.test/api/matrix';
  const controls = await conference.mountConference(client, '!room:local', iframe, () => {}, undefined, undefined, true);
  const params = new URLSearchParams(new URL(iframe.src).hash.slice(2));
  assert.equal(params.get('baseUrl'), 'https://tavern.test');
  assert.equal(client.getHomeserverUrl(), 'https://tavern.test/api/matrix');
  assert.equal(params.get('accessToken'), null);
  await controls();
});
