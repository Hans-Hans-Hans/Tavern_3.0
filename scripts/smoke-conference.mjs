// Actual embedded Element Call acceptance on the disposable HTTPS CI stack.
// This observes the shipped widget; it never replaces its SDK/media/network.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isCiRoomId } from './ci-room-id.mjs';
import { matrixSmokeRequest } from './matrix-smoke-request.mjs';

const ORIGIN = 'https://chat.example.test';
const ALICE = '@cialice:chat.example.test', BOB = '@cibob:chat.example.test';
const FRAME = 'iframe[title="Tavern encrypted conference"]';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireProof(condition, message) { if (!condition) throw new Error(message); }
const execute = promisify(execFile);
const dockerRead = async args => (await execute('docker', args, { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout.trim();

export function proveConferenceEndpoint(network, container) {
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const media = container?.networks?.['tavern-ci_media'];
  requireProof(network?.Name === 'tavern-ci_media' && network.Driver === 'bridge' && network.Scope === 'local' && network.Internal === true && network.EnableIPv6 === false
    && network.Labels?.['com.docker.compose.project'] === 'tavern-ci' && network.Labels?.['com.docker.compose.network'] === 'media'
    && hash(network.Id) && network.IPAM?.Config?.length === 1 && network.IPAM.Config[0].Subnet === '172.30.239.0/24'
    && container?.name === '/tavern-ci-livekit-1' && container.running === true && hash(container.id)
    && container.labels?.['com.docker.compose.project'] === 'tavern-ci' && container.labels?.['com.docker.compose.service'] === 'livekit'
    && container.image === 'tavern-sfu-audio:check' && JSON.stringify(container.command) === JSON.stringify(['--config', '/config/livekit.ci.yaml'])
    && (container.ports === null || object(container.ports) && Object.keys(container.ports).length === 0)
    && object(container.networks) && Object.keys(container.networks).sort().join(',') === 'tavern-ci_media,tavern-ci_private'
    && media?.NetworkID === network.Id && media.IPAddress === '172.30.239.2' && media.IPPrefixLen === 24 && !media.GlobalIPv6Address
    && network.Containers?.[container.id]?.Name === 'tavern-ci-livekit-1' && network.Containers[container.id].IPv4Address === '172.30.239.2/24',
  'Embedded conference requires its proven isolated SFU bridge endpoint.');
}

export function proveConferenceRoom(roomId, events) {
  requireProof(isCiRoomId(roomId) && Array.isArray(events) && events.length <= 100, 'Conference requires bounded native CI room state.');
  const seen = new Set();
  for (const event of events) {
    requireProof(object(event) && typeof event.type === 'string' && typeof event.state_key === 'string' && object(event.content)
      && (event.room_id === undefined || event.room_id === roomId), 'Conference native state is malformed or belongs to another room.');
    const key = JSON.stringify([event.type, event.state_key]);
    requireProof(!seen.has(key), 'Conference native state is ambiguous.'); seen.add(key);
  }
  const find = (type, key = '') => events.find(event => event.type === type && event.state_key === key);
  const create = find('m.room.create');
  requireProof(create?.sender === ALICE && create.content['m.federate'] === false && create.content.type === undefined && create.content.additional_creators === undefined
    && (roomId.includes(':') ? create.content.room_version !== '12' : create.content.room_version === '12'), 'Conference requires its owning ordinary nonfederated native room.');
  requireProof(find('m.room.name')?.content.name === 'CI encrypted conversation'
    && find('m.room.encryption')?.content.algorithm === 'm.megolm.v1.aes-sha2'
    && find('m.room.join_rules')?.content.join_rule === 'invite'
    && find('m.room.power_levels')?.content.events?.['org.matrix.msc3401.call.member'] === 0
    && !events.some(event => event.type === 'm.space.parent' && event.content.canonical === true), 'Conference fixture encryption, invitation or call permissions changed.');
  const joined = events.filter(event => event.type === 'm.room.member' && event.content.membership === 'join').map(event => event.state_key).sort();
  requireProof(joined.length === 2 && joined[0] === ALICE && joined[1] === BOB, 'Conference requires exactly the two joined owning CI accounts.');
}

/** Serialized into the parent page. Read-only listeners in both documents
 * observe the real parent's fresh challenge and the exact iframe's replies.
 * Retain only booleans/counts/time, never URLs, JWTs, full telemetry or errors. */
export function installConferenceObserver({ nonce, roomId, owner, owners }) {
  const key = '__tavernCiConferenceSmoke', origin = 'https://chat.example.test';
  const frame = document.querySelector('iframe[title="Tavern encrypted conference"]');
  if (location.origin !== origin || !frame || window[key]) return false;
  const source = frame.contentWindow, nativeDocument = source?.document, url = new URL(frame.src), params = new URLSearchParams(url.hash.slice(2));
  const validNonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,80}$/.test(value);
  const widget = params.get('widgetId'), session = params.get('tavernTelemetry');
  if (url.origin !== origin || url.pathname !== '/element-call/index.html' || !source || !nativeDocument
    || !validNonce(widget) || !validNonce(session) || params.get('roomId') !== roomId
    || params.get('userId') !== owner.userId || params.get('deviceId') !== owner.deviceId
    || params.get('baseUrl') !== origin || params.get('perParticipantE2EE') !== 'true') return false;
  let challenge = '', sequence = 0, received = 0, since = null, status = 'waiting', packets = 0;
  const current = () => location.origin === origin && frame.isConnected && frame.contentWindow === source && source.document === nativeDocument && frame.src === url.href;
  const reset = value => { since = null; status = value; };
  const bind = event => {
    const data = event.data;
    if (!current() || event.source !== window || event.origin !== origin || !data || typeof data !== 'object' || Object.keys(data).length !== 6
      || data.type !== 'io.tavern.call.telemetry.bind' || data.version !== 1 || data.widgetId !== widget || data.session !== session || data.roomId !== roomId || !validNonce(data.document)) return;
    challenge = data.document; sequence = 0; received = 0; reset('waiting');
  };
  const message = event => {
    const data = event.data;
    if (!current() || event.source !== source || event.origin !== origin || !challenge || !data || typeof data !== 'object'
      || data.type !== 'io.tavern.call.telemetry' || data.version !== 1 || data.widgetId !== widget || data.session !== session || data.roomId !== roomId || data.document !== challenge
      || !Number.isSafeInteger(data.sequence) || data.sequence <= sequence || !Array.isArray(data.participants) || data.participants.length > 128) return;
    const now = performance.now(); if (received && now - received > 5000) reset('stale');
    sequence = data.sequence; received = now; packets++;
    if (data.connected !== true || data.reconnecting !== false) { reset('disconnected'); return; }
    const peers = data.participants;
    if (data.complete !== true || peers.length !== 2 || owners.some(expected => peers.filter(peer => peer && peer.userId === expected.userId && peer.deviceId === expected.deviceId
      && peer.local === (expected.userId === owner.userId)).length !== 1)) { reset('participants'); return; }
    if (data.e2eeEnabled !== true || peers.some(peer => peer.encrypted !== true || peer.e2eeEnabled !== true || peer.microphoneEnabled !== true)) { reset('encryption'); return; }
    status = 'ready'; since ??= now;
  };
  source.addEventListener('message', bind); window.addEventListener('message', message);
  window[key] = { nonce, read: () => {
    const now = performance.now();
    if (!current()) reset('scope'); else if (received && now - received > 5000) reset('stale');
    return { status, stableMs: since === null ? 0 : Math.max(0, now - since), ageMs: received ? Math.max(0, now - received) : null, packets };
  }, stop: () => { source.removeEventListener('message', bind); window.removeEventListener('message', message); if (window[key]?.nonce === nonce) delete window[key]; } };
  return true;
}

export async function conferenceSmoke({ alice, bob, aliceSession, bobSession, roomId, origin, api }, { docker = dockerRead } = {}) {
  const ownerValid = (value, id) => object(value) && value.userId === id && value.admin === false && typeof value.deviceId === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(value.deviceId);
  requireProof(process.env.TAVERN_CI_SMOKE === 'true' && process.env.TAVERN_CI_TLS === '/tmp/tavern-ci-tls' && origin === ORIGIN && isCiRoomId(roomId)
    && ownerValid(aliceSession, ALICE) && ownerValid(bobSession, BOB) && typeof api === 'function', 'Embedded conference requires the exact isolated CI stack and ordinary accounts.');
  requireProof(alice && bob && alice !== bob && alice.context() !== bob.context(), 'Embedded conference requires independent browser contexts.');
  const owners = new Map([[alice, { ...aliceSession }], [bob, { ...bobSession }]]), nonce = randomUUID(), opened = new Set();
  let deadline = Date.now() + 150000;
  let stage = 'scope', succeeded = false;
  function pageScope(page) {
    let url; try { url = new URL(page.url()); } catch { /* fixed failure below */ }
    requireProof(url?.origin === ORIGIN && new URLSearchParams(url.hash.slice(1)).get('room') === roomId, 'Embedded conference owning page changed.');
  }
  async function run(operation, label, timeout = 20000) {
    stage = label; const remaining = Math.min(timeout, deadline - Date.now()); requireProof(remaining > 0, 'Embedded conference exceeded its deadline.');
    let timer;
    try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), remaining); })]); }
    catch { throw new Error('Embedded conference failed during ' + label + '.'); }
    finally { clearTimeout(timer); }
  }
  async function read(page, path, matrix = false) {
    pageScope(page);
    const response = await run(() => matrixSmokeRequest(() => api(page, path, undefined, matrix)), 'native-proof'); pageScope(page); return response;
  }
  async function session(page) {
    const expected = owners.get(page), response = await read(page, '/api/auth/session');
    requireProof(response?.status === 200 && response.data?.userId === expected.userId && response.data?.deviceId === expected.deviceId && response.data?.admin === false, 'Embedded conference owning session changed.');
  }
  async function scope(page) {
    await session(page); const expected = owners.get(page), who = await read(page, '/_matrix/client/v3/account/whoami', true);
    requireProof(who?.status === 200 && who.data?.user_id === expected.userId && who.data?.device_id === expected.deviceId, 'Embedded conference native account changed.');
    const state = await read(page, '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/state', true);
    requireProof(state?.status === 200, 'Embedded conference native room is unavailable.'); proveConferenceRoom(roomId, state.data); await session(page); return state.data;
  }
  async function observation(page) {
    return run(() => page.evaluate(nonce => { const probe = window.__tavernCiConferenceSmoke; return probe?.nonce === nonce ? probe.read() : null; }, nonce), 'observation');
  }
  try {
    const network = JSON.parse(await run(() => docker(['network', 'inspect', 'tavern-ci_media', '--format', '{{json .}}']), 'media-endpoint'));
    const projection = '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"image":{{json .Config.Image}},"command":{{json .Config.Cmd}},"networks":{{json .NetworkSettings.Networks}},"ports":{{json .HostConfig.PortBindings}}}';
    const container = JSON.parse(await run(() => docker(['container', 'inspect', 'tavern-ci-livekit-1', '--format', projection]), 'media-endpoint'));
    proveConferenceEndpoint(network, container);
    for (const page of owners.keys()) await scope(page);
    for (const page of owners.keys()) {
      // Enumerating already-permitted labels never opens a capture device.
      const synthetic = await run(() => page.evaluate(async () => {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audio = devices.filter(value => value.kind === 'audioinput'), video = devices.filter(value => value.kind === 'videoinput');
        return audio.length > 0 && video.length > 0 && audio.every(value => /^Fake (Default )?Audio Input(?: [0-9]+)?$/i.test(value.label)) && video.every(value => /^fake_device_[0-9]+$/i.test(value.label));
      }), 'synthetic-devices');
      requireProof(synthetic === true, 'Embedded conference requires Chromium synthetic capture devices and origin-scoped permission.');
      requireProof(await run(() => page.locator(FRAME).count(), 'initial-frame') === 0, 'Embedded conference must not replace another active call.');
    }
    for (const page of owners.keys()) {
      await scope(page); opened.add(page);
      await run(() => page.getByRole('button', { name: 'Join conference', exact: true }).click({ timeout: 15000 }), 'open-widget');
      const lobby = page.frameLocator(FRAME).getByTestId('lobby_joinCall');
      await run(() => lobby.waitFor({ state: 'visible', timeout: 45000 }), 'widget-lobby', 45000);
      await scope(page);
      requireProof(await run(() => page.evaluate(installConferenceObserver, { nonce, roomId, owner: owners.get(page), owners: [...owners.values()].map(({ userId, deviceId }) => ({ userId, deviceId })) }), 'observer-binding'), 'Embedded conference iframe did not match its owning native device.');
      await run(() => lobby.click({ timeout: 15000 }), 'join-widget');
    }
    await run(() => Promise.all([...owners.keys()].map(page => page.waitForFunction(nonce => {
      const probe = window.__tavernCiConferenceSmoke, value = probe?.nonce === nonce ? probe.read() : null;
      return value?.status === 'ready' && value.stableMs >= 20000 && value.ageMs !== null && value.ageMs <= 5000 && value.packets >= 10;
    }, nonce, { timeout: 75000, polling: 250 }))), 'connected-encryption', 75000);
    for (const page of owners.keys()) await scope(page);
    for (const page of owners.keys()) {
      const value = await observation(page);
      requireProof(value?.status === 'ready' && value.stableMs >= 20000 && value.ageMs <= 5000 && value.packets >= 10, 'Both embedded calls must retain fresh, complete encrypted two-device observations for twenty seconds.');
    }
    succeeded = true;
  } catch {
    const allowed = new Set(['waiting', 'disconnected', 'participants', 'encryption', 'ready', 'scope', 'stale']);
    const statuses = [];
    for (const page of owners.keys()) {
      let timer;
      try { const value = await Promise.race([page.evaluate(nonce => { const probe = window.__tavernCiConferenceSmoke; return probe?.nonce === nonce ? probe.read() : null; }, nonce), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 1500); })]); statuses.push(allowed.has(value?.status) ? value.status : 'unavailable'); }
      catch { statuses.push('unavailable'); }
      finally { clearTimeout(timer); }
    }
    throw new Error('Embedded conference failed (stage=' + stage + ', observations=' + statuses.join(',') + ').');
  } finally {
    // Teardown has its own bounded grace period after a connection deadline.
    deadline = Date.now() + 40000;
    let cleanupFailed = false;
    for (const page of opened) {
      try {
        await session(page);
        const owned = await page.evaluate(({ nonce, roomId }) => {
          const probe = window.__tavernCiConferenceSmoke, frame = document.querySelector('iframe[title="Tavern encrypted conference"]');
          if (!frame) return 'closed';
          const url = new URL(frame.src), params = new URLSearchParams(url.hash.slice(2));
          return url.origin === location.origin && params.get('roomId') === roomId && (!probe || probe.nonce === nonce) ? 'owned' : 'changed';
        }, { nonce, roomId });
        if (owned === 'changed') throw new Error();
        if (owned === 'owned') { await page.getByRole('button', { name: 'Leave conference', exact: true }).click({ timeout: 10000 }); await page.locator(FRAME).waitFor({ state: 'detached', timeout: 15000 }); }
      } catch { cleanupFailed = true; }
      finally { try { await page.evaluate(nonce => { const probe = window.__tavernCiConferenceSmoke; if (probe?.nonce === nonce) probe.stop(); }, nonce); } catch { cleanupFailed = true; } }
    }
    if (cleanupFailed && succeeded) throw new Error('Embedded conference connected but clean UI leave could not be confirmed.');
  }
  console.log('PASS: two ordinary CI accounts joined the real embedded conference with synthetic devices, retained complete encrypted participant observations for twenty seconds, and left through the UI.');
}
