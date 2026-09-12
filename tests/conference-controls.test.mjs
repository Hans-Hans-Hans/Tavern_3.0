import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadTs } from './load-ts.mjs';
globalThis.location = { origin: 'https://tavern.test' };
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

function setup() {
  let api, telemetry;
  class WidgetApi extends EventEmitter {
    constructor(_widget, _iframe, driver) { super(); api = this; this.driver=driver; this.controls = { audio_enabled: true, video_enabled: false }; this.transport = { reply: async (_event, response) => { this.lastReply = response; }, send: async (action, patch) => { this.lastAction = action; if (action === 'io.element.device_mute' && !this.unavailable) Object.assign(this.controls, patch); return this.controls; } }; }
    setViewedRoomId() {}
    stop() { this.stopped = true; }
  }
  const enums = new Proxy({}, { get: (_target, key) => String(key) });
  const conference = loadTs('../lib/conference.ts', {
    './matrix-media': loadTs('../lib/matrix-media.ts', {}),
    './conference-url': loadTs('../lib/conference-url.ts', {}),
    './conference-telemetry': { observeConferenceTelemetry: options => { telemetry = options; return () => {}; } },
    './media-session': { claimMedia() {}, releaseMedia() {} },
    'matrix-js-sdk': { ClientEvent: enums, EventType: enums, MatrixEventEvent: enums, RoomEvent: enums, RoomStateEvent: enums },
    'matrix-widget-api': { ClientWidgetApi: WidgetApi, Widget: class {}, WidgetDriver: class {}, WidgetEventCapability: {}, EventDirection: {}, MatrixCapabilities: {}, OpenIDRequestState: {} },
  });
  const room = { roomId:'!room:local',hasEncryptionStateEvent:()=>true,getMyMembership: () => 'join', loadMembersIfNeeded: async () => {}, currentState: { maySendStateEvent: () => true } };
  const client = new EventEmitter(); Object.assign(client, { getRoom: () => room, getCrypto: () => ({ isEncryptionEnabledInRoom: async () => true }), _unstable_getRTCTransports: async () => [{}], getUserId: () => '@me:local', getDeviceId: () => 'DEVICE', getHomeserverUrl: () => 'https://tavern.test' });
  return { conference, client, room, api: () => api, telemetry: () => telemetry };
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

test('hangup acknowledgement keeps the widget and driver alive until its native membership clear completes',async()=>{
  const {conference,client,api}=setup(),iframe={src:''},clear=deferred();
  client.sendStateEvent=async(_room,_type,value)=>{if(!Object.keys(value).length)await clear.promise;return {event_id:'$state'};};
  const controls=await conference.mountConference(client,'!room:local',iframe,()=>{},undefined,undefined,true);
  const driver=api().driver,key='_@me:local_DEVICE_m.call';
  await driver.sendEvent('GroupCallMemberPrefix',{device_id:'DEVICE'},key);
  let clearing;
  api().transport.send=async()=>{clearing=driver.sendEvent('GroupCallMemberPrefix',{},key);return {};};
  const stopping=controls();assert.equal(controls(),stopping);
  await new Promise(resolve=>setImmediate(resolve));
  assert.notEqual(api().stopped,true);assert.notEqual(iframe.src,'about:blank');
  await assert.rejects(driver.sendEvent('GroupCallMemberPrefix',{device_id:'DEVICE'},key),/leaving/);
  clear.resolve();await clearing;await stopping;
  assert.equal(api().stopped,true);assert.equal(iframe.src,'about:blank');
});

test('an empty membership is sent after an in-flight membership write instead of racing it',async()=>{
  const {conference,client,api}=setup(),iframe={src:''},joining=deferred(),writes=[];
  client.sendStateEvent=async(_room,_type,value)=>{writes.push(value);if(Object.keys(value).length)await joining.promise;return {event_id:'$state'};};
  const controls=await conference.mountConference(client,'!room:local',iframe,()=>{},undefined,undefined,true);
  const driver=api().driver,key='_@me:local_DEVICE_m.call';
  const joined=driver.sendEvent('GroupCallMemberPrefix',{device_id:'DEVICE'},key);
  await new Promise(resolve=>setImmediate(resolve));
  let clearing;
  api().transport.send=async()=>{clearing=driver.sendEvent('GroupCallMemberPrefix',{},key);return {};};
  const stopping=controls();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes.length,1);assert.notEqual(api().stopped,true);
  joining.resolve();await joined;await clearing;await stopping;
  assert.deepEqual(writes,[{device_id:'DEVICE'},{}]);assert.equal(api().stopped,true);
});

test('native delayed-leave submission stays available during teardown and completes only its owned device key',async()=>{
  const {conference,client,api}=setup(),iframe={src:''},clear=deferred();
  client.sendStateEvent=async()=>({event_id:'$joined'});
  client._unstable_sendDelayedStateEvent=async()=>({delay_id:'owned-delay'});
  client._unstable_sendScheduledDelayedEvent=async id=>{assert.equal(id,'owned-delay');await clear.promise;};
  const controls=await conference.mountConference(client,'!room:local',iframe,()=>{},undefined,undefined,true);
  const driver=api().driver,key='_@me:local_DEVICE_m.call';
  await driver.sendDelayedEvent(8000,'GroupCallMemberPrefix',{},key);
  await driver.sendEvent('GroupCallMemberPrefix',{device_id:'DEVICE'},key);
  let clearing;
  api().transport.send=async()=>{clearing=driver.sendScheduledDelayedEvent('owned-delay');return {};};
  const stopping=controls();await new Promise(resolve=>setImmediate(resolve));
  assert.notEqual(api().stopped,true);
  await assert.rejects(driver.sendScheduledDelayedEvent('another-device-delay'),/Unknown conference delayed event/);
  clear.resolve();await clearing;await stopping;
  assert.equal(api().stopped,true);assert.equal(iframe.src,'about:blank');
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

test('voice mount requests audio-only startup and stops accepting observations after native room replacement', async () => {
  const { conference, client, room, telemetry } = setup(), iframe = { src: '' };
  const controls = await conference.mountConference(client, '!room:local', iframe, () => {}, undefined, undefined, true, undefined, { voiceOnly: true });
  assert.equal(new URLSearchParams(new URL(iframe.src).hash.slice(2)).get('intent'), 'start_call_voice');
  assert.equal(telemetry().isCurrent(), true);
  client.getRoom = () => ({ ...room });
  assert.equal(telemetry().isCurrent(), false);
  await controls();
});

test('telemetry ownership includes the captured homeserver and mount cancellation', async () => {
  const { conference, client, telemetry } = setup(), iframe = { src: '' }, controller = new AbortController();
  const controls = await conference.mountConference(client, '!room:local', iframe, () => {}, controller.signal, undefined, true);
  client.getHomeserverUrl = () => 'https://another.test';
  assert.equal(telemetry().isCurrent(), false);
  client.getHomeserverUrl = () => 'https://tavern.test';
  controller.abort();
  assert.equal(telemetry().isCurrent(), false);
  await controls();
});

test('persistent widget honors its advertised always-on-screen action without closing or remounting', async () => {
  const { conference, client, api } = setup(), iframe = { src: '' }; let closed = 0;
  const controls = await conference.mountConference(client, '!room:local', iframe, () => closed++, undefined, undefined, true);
  const url = iframe.src;
  for (const value of [true, false]) {
    let handled = false;
    api().emit('action:set_always_on_screen', { preventDefault() { handled = true; }, detail: { data: { value } } });
    assert.equal(handled, true); assert.deepEqual(api().lastReply, { success: true });
    assert.equal(closed, 0); assert.equal(iframe.src, url);
  }
  api().emit('action:set_always_on_screen', { preventDefault() {}, detail: { data: { value: 'true' } } });
  assert.deepEqual(api().lastReply, { success: false });
  await controls();
});
