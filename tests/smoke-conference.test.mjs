import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { conferenceSmoke, inspectSyntheticDevices, installConferenceObserver, proveConferenceEndpoint, proveConferenceRoom } from '../scripts/smoke-conference.mjs';

const origin = 'https://chat.example.test', roomId = '!Nhcu5BS-UMnFX7hBVfVSoXiD7OgH6iRT-xyIuqDnpYQ';
const owners = [{ userId: '@cialice:chat.example.test', deviceId: 'CI_ALICE', admin: false }, { userId: '@cibob:chat.example.test', deviceId: 'CI_BOB', admin: false }];
const widget = 'widget_nonce_123456789012345', session = 'session_nonce_123456789012345', challenge = 'document_nonce_123456789012345';
function endpoint() {
  const id = 'c'.repeat(64), networkId = 'a'.repeat(64);
  return { network: { Id: networkId, Name: 'tavern-ci_media', Driver: 'bridge', Scope: 'local', Internal: true, EnableIPv6: false,
    Labels: { 'com.docker.compose.project': 'tavern-ci', 'com.docker.compose.network': 'media' }, IPAM: { Config: [{ Subnet: '172.30.239.0/24' }] }, Containers: { [id]: { Name: 'tavern-ci-livekit-1', IPv4Address: '172.30.239.2/24' } } },
  container: { id, name: '/tavern-ci-livekit-1', running: true, labels: { 'com.docker.compose.project': 'tavern-ci', 'com.docker.compose.service': 'livekit' },
    image: 'tavern-sfu-audio:check', command: ['--config', '/config/livekit.ci.yaml'], ports: {}, networks: { 'tavern-ci_private': {}, 'tavern-ci_media': { NetworkID: networkId, IPAddress: '172.30.239.2', IPPrefixLen: 24 } } } };
}
function nativeState() {
  return [{ type: 'm.room.create', state_key: '', sender: owners[0].userId, content: { room_version: '12', 'm.federate': false } },
    { type: 'm.room.name', state_key: '', content: { name: 'CI encrypted conversation' } }, { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } }, { type: 'm.room.power_levels', state_key: '', content: { events: { 'org.matrix.msc3401.call.member': 0 } } },
    ...owners.map(owner => ({ type: 'm.room.member', state_key: owner.userId, content: { membership: 'join' } }))];
}
const frameUrl = owner => origin + '/element-call/index.html#?' + new URLSearchParams({ widgetId: widget, tavernTelemetry: session, roomId, userId: owner.userId, deviceId: owner.deviceId, baseUrl: origin, perParticipantE2EE: 'true' });

test('pre-capture proof distinguishes private labels, missing and physical devices without exposing names or opening capture', async () => {
  let captures = 0;
  const inspect = (devices, secure = true) => runInNewContext('(' + inspectSyntheticDevices.toString() + ')', { isSecureContext: secure, navigator: { mediaDevices: {
    enumerateDevices: async () => devices, getUserMedia: () => { captures++; throw new Error('No capture permitted'); },
  } } })();
  const devices = [{ kind: 'audioinput', label: 'Fake Default Audio Input' }, { kind: 'videoinput', label: 'fake_device_0' }];
  assert.equal(await inspect(devices), 'synthetic');
  assert.equal(await inspect(devices.map(value => ({ ...value, label: '' }))), 'unlabeled');
  assert.equal(await inspect(devices.slice(0, 1)), 'missing');
  assert.equal(await inspect([...devices, { kind: 'audioinput', label: 'PRIVATE OWNER MICROPHONE' }]), 'unexpected');
  assert.equal(await inspect(devices, false), 'unavailable');
  assert.equal(captures, 0);
});

test('real observer requires the current iframe challenge, both devices and twenty continuous seconds of fresh encrypted audio observations', () => {
  let time = 100; const parentListeners = new Set(), childListeners = new Set();
  const child = { document: {}, addEventListener: (_type, fn) => childListeners.add(fn), removeEventListener: (_type, fn) => childListeners.delete(fn) };
  const window = { addEventListener: (_type, fn) => parentListeners.add(fn), removeEventListener: (_type, fn) => parentListeners.delete(fn) };
  const frame = { src: frameUrl(owners[0]), contentWindow: child, isConnected: true };
  const install = runInNewContext('(' + installConferenceObserver.toString() + ')', { window, document: { querySelector: () => frame }, location: { origin }, URL, URLSearchParams, performance: { now: () => time } });
  assert.equal(install({ nonce: 'probe', roomId, owner: owners[0], owners }), true);
  const bind = { type: 'io.tavern.call.telemetry.bind', version: 1, widgetId: widget, session, roomId, document: challenge };
  const payload = sequence => ({ type: 'io.tavern.call.telemetry', version: 1, widgetId: widget, session, roomId, document: challenge, sequence,
    connected: true, reconnecting: false, complete: true, e2eeEnabled: true,
    participants: owners.map((owner, i) => ({ ...owner, local: i === 0, encrypted: true, e2eeEnabled: true, microphoneEnabled: true })) });
  const emit = (data, source = child, eventOrigin = origin) => parentListeners.forEach(fn => fn({ source, origin: eventOrigin, data }));
  emit(payload(1)); assert.equal(window.__tavernCiConferenceSmoke.read().status, 'waiting');
  childListeners.forEach(fn => fn({ source: window, origin, data: bind }));
  emit(payload(1), {}); emit(payload(1), child, 'https://other.test'); assert.equal(window.__tavernCiConferenceSmoke.read().packets, 0);
  for (let index = 1; index <= 21; index++) { emit(payload(index)); if (index < 21) time += 1000; }
  assert.equal(window.__tavernCiConferenceSmoke.read().stableMs, 20000);
  const unknown = payload(22); unknown.participants[1].encrypted = null; emit(unknown);
  assert.equal(window.__tavernCiConferenceSmoke.read().status, 'encryption'); assert.equal(window.__tavernCiConferenceSmoke.read().stableMs, 0);
  const wrongDevice = payload(23); wrongDevice.participants[1].deviceId = 'REPLACEMENT'; emit(wrongDevice); assert.equal(window.__tavernCiConferenceSmoke.read().status, 'participants');
  emit(payload(24)); time += 6000; assert.equal(window.__tavernCiConferenceSmoke.read().status, 'stale');
  emit(payload(25)); assert.equal(window.__tavernCiConferenceSmoke.read().stableMs, 0);
  frame.isConnected = false; assert.equal(window.__tavernCiConferenceSmoke.read().status, 'scope'); frame.isConnected = true;
  const fatal = payload(26); fatal.failure = { code: 'UNKNOWN_ERROR' }; emit(fatal);
  assert.equal(window.__tavernCiConferenceSmoke.read().status, 'fatal');
  childListeners.forEach(fn => fn({ source: window, origin, data: bind }));
  for (let i = 1; i <= 25; i++) { time += 1000; emit(payload(i)); }
  assert.equal(window.__tavernCiConferenceSmoke.read().status, 'fatal');
  assert.equal(window.__tavernCiConferenceSmoke.read().stableMs, 0);
  child.document = {}; assert.equal(window.__tavernCiConferenceSmoke.read().status, 'fatal');
  window.__tavernCiConferenceSmoke.stop(); assert.equal(parentListeners.size + childListeners.size, 0); assert.equal(window.__tavernCiConferenceSmoke, undefined);
});

test('endpoint proof rejects published, foreign, noninternal or mismatched SFUs and accepts only the owned fixed bridge', () => {
  const value = endpoint(); proveConferenceEndpoint(value.network, value.container);
  for (const mutate of [v => v.network.Internal = false, v => v.network.Name = 'production', v => v.network.IPAM.Config[0].Subnet = '10.0.0.0/8',
    v => v.container.networks['tavern-ci_media'].IPAddress = '172.30.239.3', v => v.container.networks.other = {}, v => v.container.ports = { '7882/udp': [] },
    v => v.container.labels['com.docker.compose.project'] = 'another', v => v.container.command = ['--config', '/config/livekit.yaml'], v => v.container.image = 'stock-sfu']) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => proveConferenceEndpoint(changed.network, changed.container), /proven isolated/);
  }
});

test('native proof rejects inherited, foreign, unencryped or unauthorized call rooms', () => {
  proveConferenceRoom(roomId, nativeState());
  for (const mutate of [v => v[0].sender = owners[1].userId, v => v[0].content.room_version = '11', v => v[0].content['m.federate'] = true,
    v => v[0].content.additional_creators = [owners[1].userId], v => v[2].content.algorithm = 'none', v => v[4].content.events = {},
    v => v.push({ type: 'm.space.parent', state_key: '!parent:local', content: { canonical: true } }), v => v.at(-1).content.membership = 'leave', v => v.push(v[0])]) {
    const changed = nativeState(); mutate(changed); assert.throws(() => proveConferenceRoom(roomId, changed));
  }
});

async function ci(run) {
  const before = [process.env.TAVERN_CI_SMOKE, process.env.TAVERN_CI_TLS]; process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/tavern-ci-tls';
  try { await run(); } finally { ['TAVERN_CI_SMOKE', 'TAVERN_CI_TLS'].forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; }); }
}
function fixture({ synthetic = true, connected = true, beforeApi } = {}) {
  const actions = [], states = nativeState(), current = owners.map(owner => ({ ...owner })); let dockerCalls = 0;
  const pages = owners.map((owner, index) => {
    const context = {}; let attached = false, probe;
    const page = { url: () => origin + '/#room=' + encodeURIComponent(roomId), context: () => context };
    const frame = { src: frameUrl(owner) };
    const vm = () => ({ window: { __tavernCiConferenceSmoke: probe }, location: { origin }, document: { querySelector: () => attached ? frame : null }, URL, URLSearchParams });
    page.evaluate = async (fn, args) => {
      if (fn === installConferenceObserver) { probe = { nonce: args.nonce, owns: () => true, read: () => ({ status: connected ? 'ready' : 'encryption', stableMs: 21000, ageMs: 500, packets: 25 }), stop: () => { probe = undefined; actions.push('observer-stop-' + index); } }; return true; }
      if (fn === inspectSyntheticDevices) return synthetic ? 'synthetic' : 'unexpected';
      return runInNewContext('(' + fn.toString() + ')', vm())(args);
    };
    page.getByRole = (_role, { name }) => ({ click: async () => { actions.push(name + '-' + index); attached = name === 'Join conference'; if (name === 'Leave conference') { const event = states.find(event => event.type === 'org.matrix.msc3401.call.member' && event.state_key === '_' + owner.userId + '_' + owner.deviceId + '_m.call'); if (event) event.content = {}; } } });
    page.locator = () => ({ count: async () => attached ? 1 : 0, waitFor: async ({ state }) => { assert.equal(state, 'detached'); assert.equal(attached, false); } });
    page.frameLocator = () => ({ getByTestId: id => { assert.equal(id, 'lobby_joinCall'); return { waitFor: async () => { actions.push('lobby-' + index); }, click: async () => { actions.push('native-widget-join-' + index); states.push({ type: 'org.matrix.msc3401.call.member', state_key: '_' + owner.userId + '_' + owner.deviceId + '_m.call', content: { application: 'm.call', device_id: owner.deviceId } }); } }; } });
    page.waitForFunction = async (fn, nonce, options) => { assert.equal(options.polling, 250); assert.equal(runInNewContext('(' + fn.toString() + ')', vm())(nonce), true); actions.push('twenty-seconds-' + index); };
    return page;
  });
  const [alice, bob] = pages;
  const api = async (page, path) => {
    const index = pages.indexOf(page); if (beforeApi) beforeApi({ path, index, current, actions });
    if (path === '/api/auth/session') return { status: 200, data: current[index] };
    if (path.endsWith('/account/whoami')) return { status: 200, data: { user_id: current[index].userId, device_id: current[index].deviceId } };
    if (path.endsWith('/state')) return { status: 200, data: structuredClone(states) };
    throw new Error('Unexpected API path');
  };
  return { args: { alice, bob, aliceSession: owners[0], bobSession: owners[1], roomId, origin, api }, actions,
    adapters: { docker: async args => { dockerCalls++; const value = endpoint(); return JSON.stringify(args[0] === 'network' ? value.network : value.container); } }, dockerCalls: () => dockerCalls };
}

test('orchestration uses actual widget UI boundaries and leaves both owning calls after successful continuous observations', () => ci(async () => {
  const f = fixture(); await conferenceSmoke(f.args, f.adapters);
  assert.deepEqual(f.actions.filter(value => /widget-join|twenty-seconds|Leave conference/.test(value)), ['native-widget-join-0', 'native-widget-join-1', 'twenty-seconds-0', 'twenty-seconds-1', 'Leave conference-0', 'Leave conference-1']);
  assert.equal(f.dockerCalls(), 2); assert.equal(f.actions.filter(value => value.startsWith('observer-stop')).length, 2);
}));

test('environment and synthetic-device guards deny before opening any call or physical capture', () => ci(async () => {
  const f = fixture(); await assert.rejects(conferenceSmoke({ ...f.args, origin: 'https://production.test' }, f.adapters), /exact isolated/); assert.equal(f.dockerCalls(), 0);
  const real = fixture({ synthetic: false }); await assert.rejects(conferenceSmoke(real.args, real.adapters), /synthetic-devices/); assert.deepEqual(real.actions, []);
}));

test('missing encryption fails with fixed diagnostics and still closes both fixture calls', () => ci(async () => {
  const f = fixture({ connected: false }); await assert.rejects(conferenceSmoke(f.args, f.adapters), /stage=connected-encryption, observations=encryption,encryption/);
  assert.deepEqual(f.actions.filter(value => value.startsWith('Leave conference')), ['Leave conference-0', 'Leave conference-1']);
}));

test('owner replacement during lobby preparation cannot join the replacement account or click its leave control', () => ci(async () => {
  const f = fixture({ beforeApi: ({ index, current, actions }) => { if (index === 0 && actions.includes('lobby-0')) current[0] = { ...owners[0], deviceId: 'REPLACED' }; } });
  await assert.rejects(conferenceSmoke(f.args, f.adapters), /Embedded conference failed/);
  assert.equal(f.actions.some(value => /widget-join|Leave conference/.test(value)), false);
}));
