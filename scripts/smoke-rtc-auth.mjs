// Native token exchange acceptance. The caller owns the freshly created,
// encrypted two-user baseline room; this probe never joins an SFU participant.
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { isCiRoomId } from './ci-room-id.mjs';
import { matrixSmokeRequest } from './matrix-smoke-request.mjs';

const ORIGIN = 'https://chat.example.test';
const ALICE = '@cialice:chat.example.test', BOB = '@cibob:chat.example.test';
const errors = new Set(['CALL_OPENID_UNAVAILABLE', 'CALL_OPENID_REJECTED', 'CALL_ISSUER_OPENID_REJECTED', 'CALL_SFU_ROOM_CREATION_FAILED', 'CALL_ISSUER_UNAVAILABLE', 'CALL_ACCESS_DENIED']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireProof(condition, message) { if (!condition) throw new Error(message); }
function hashTuple(value) {
  // Pinned lk-jwt-service v0.6.0 uses Go json.Marshal and raw standard Base64.
  const escaped = JSON.stringify(value).replace(/[&<>\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  return createHash('sha256').update(escaped).digest('base64').replace(/=+$/, '');
}

function proveRoom(roomId, events) {
  requireProof(Array.isArray(events) && events.length <= 100, 'RTC fixture state must be bounded.');
  const seen = new Set();
  for (const event of events) {
    requireProof(object(event) && typeof event.type === 'string' && typeof event.state_key === 'string' && object(event.content), 'RTC fixture state must be well formed.');
    const key = JSON.stringify([event.type, event.state_key]);
    requireProof(!seen.has(key) && (event.room_id === undefined || event.room_id === roomId), 'RTC fixture state must belong to one unambiguous room.'); seen.add(key);
  }
  const find = (type, key = '') => events.find(event => event.type === type && event.state_key === key);
  const create = find('m.room.create');
  requireProof(create?.sender === ALICE && create.content['m.federate'] === false
    && create.content.type === undefined && create.content.additional_creators === undefined,
  'RTC fixture must be the ordinary nonfederated conversation created by CI Alice.');
  requireProof(roomId.includes(':') ? create.content.room_version !== '12' : create.content.room_version === '12', 'RTC fixture must have matching native room-version proof.');
  requireProof(find('m.room.name')?.content.name === 'CI encrypted conversation'
    && find('m.room.encryption')?.content.algorithm === 'm.megolm.v1.aes-sha2'
    && find('m.room.join_rules')?.content.join_rule === 'invite'
    && !events.some(event => event.type === 'm.space.parent' && event.content.canonical === true),
  'RTC fixture must retain its exact encrypted private conversation scope.');
  requireProof(find('m.room.power_levels')?.content.events?.['org.matrix.msc3401.call.member'] === 0,
    'RTC fixture must retain the ordinary native call-membership permission used by UI-created rooms.');
  const joined = events.filter(event => event.type === 'm.room.member' && event.content.membership === 'join').map(event => event.state_key).sort();
  requireProof(joined.length === 2 && joined[0] === ALICE && joined[1] === BOB, 'RTC fixture requires both owning CI accounts joined and no other participant.');
}

function proveToken(response, roomId, owner, member, modern) {
  // Decode only to check the acceptance result's scope. The production gateway
  // authenticates the signature; the real SFU /rtc/validate request below must
  // independently accept it. Never include token/claims in an assertion error.
  if (response?.status !== 200) {
    const status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? String(response.status) : 'unknown';
    const code = errors.has(response?.data?.errcode) ? response.data.errcode : 'unclassified';
    throw new Error('RTC token exchange must return HTTP 200 (status=' + status + ', code=' + code + ').');
  }
  const result = response.data;
  requireProof(object(result) && result.url === 'wss://chat.example.test/livekit/sfu', 'RTC exchange must return the exact public WSS endpoint.');
  requireProof(typeof result.jwt === 'string' && result.jwt.length <= 8192, 'RTC exchange must return a bounded signed token.');
  let header, claims;
  try {
    const parts = result.jwt.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part) || Buffer.from(part, 'base64url').toString('base64url') !== part)) throw new Error();
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw new Error('RTC exchange returned an invalid token encoding.'); }
  const now = Math.floor(Date.now() / 1000);
  requireProof(object(header) && header.alg === 'HS256' && object(claims)
    && typeof claims.iss === 'string' && claims.iss.length > 0 && claims.iss.length <= 512
    && Number.isSafeInteger(claims.exp) && claims.exp > now
    && Number.isSafeInteger(claims.nbf) && claims.nbf <= now + 5,
  'RTC exchange must return a currently valid HS256 grant.');
  requireProof(claims.sub === (modern ? hashTuple([owner.userId, owner.deviceId, member]) : owner.userId + ':' + owner.deviceId)
    && object(claims.video) && claims.video.roomJoin === true && claims.video.room === hashTuple([roomId, 'm.call#ROOM'])
    && !['roomAdmin', 'roomCreate', 'roomList', 'roomRecord', 'ingressAdmin'].some(key => claims.video[key]),
  'RTC exchange must bind the exact native room and owning device without administrative grants.');
  return result.jwt;
}

export async function rtcAuthSmoke({ alice, bob, aliceSession, bobSession, roomId, origin, api }) {
  const validOwner = (value, id) => object(value) && value.userId === id && value.admin === false
    && typeof value.deviceId === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value.deviceId);
  requireProof(process.env.TAVERN_CI_SMOKE === 'true' && process.env.TAVERN_CI_TLS === '/tmp/tavern-ci-tls'
    && origin === ORIGIN && isCiRoomId(roomId) && validOwner(aliceSession, ALICE) && validOwner(bobSession, BOB)
    && typeof api === 'function', 'RTC authentication acceptance requires the exact isolated CI stack and accounts.');
  requireProof(alice && bob && alice !== bob && typeof alice.context === 'function' && typeof bob.context === 'function'
    && alice.context() !== bob.context(), 'RTC accounts require their own browser contexts.');
  const owners = new Map([[alice, { ...aliceSession }], [bob, { ...bobSession }]]);
  const deadline = Date.now() + 120000;
  function pageOrigin(page) {
    let actual; try { actual = new URL(page.url()).origin; } catch { /* fixed error below */ }
    requireProof(actual === ORIGIN, 'RTC requests require the isolated owning browser origin.');
  }
  for (const page of owners.keys()) pageOrigin(page);
  async function bounded(operation, stage) {
    const remaining = Math.min(30000, deadline - Date.now());
    requireProof(remaining > 0, 'RTC authentication acceptance exceeded its deadline.');
    let timer;
    try {
      // The surrounding harness closes browser contexts after a failure. Never
      // replay an ambiguous OpenID/token issuance or retain the rejected body.
      return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), remaining); })]);
    } catch { throw new Error('RTC authentication transport failed during ' + stage + '.'); }
    finally { clearTimeout(timer); }
  }
  async function request(page, path, body, matrix = false) {
    pageOrigin(page);
    const result = await bounded(() => api(page, path, body, matrix), matrix ? 'native verification' : path === '/api/auth/session' ? 'session verification' : 'token exchange');
    pageOrigin(page); return result;
  }
  async function read(page, path, matrix = false) {
    return matrixSmokeRequest(() => request(page, path, undefined, matrix), async ms => {
      requireProof(ms < deadline - Date.now(), 'RTC authentication acceptance exceeded its retry deadline.'); await pause(ms);
    });
  }
  async function session(page) {
    const expected = owners.get(page), result = await read(page, '/api/auth/session');
    requireProof(result?.status === 200 && result.data?.userId === expected.userId
      && result.data?.deviceId === expected.deviceId && result.data?.admin === false,
    'RTC owning CI account/session changed.');
    return expected;
  }
  async function scope(page) {
    const owner = await session(page);
    const native = await read(page, '/_matrix/client/v3/account/whoami', true);
    requireProof(native?.status === 200 && native.data?.user_id === owner.userId && native.data?.device_id === owner.deviceId,
      'RTC native session must match the owning CI device.');
    const state = await read(page, '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/state', true);
    requireProof(state?.status === 200, 'RTC native fixture state must be readable by its joined owner.');
    proveRoom(roomId, state.data); await session(page); return owner;
  }
  async function validate(page, owner, token) {
    await session(page); pageOrigin(page);
    // Pinned LiveKit 3cfbd124 pkg/service/rtcservice.go v0Validate validates
    // grants but never invokes the WebSocket join/start-session handler. Keep
    // the credential in a header so failure URLs/logs cannot disclose it.
    const status = await bounded(() => page.evaluate(async ({ expected, jwt }) => {
      if (location.origin !== 'https://chat.example.test') return 0;
      const headers = { 'X-Tavern-Device': expected.deviceId };
      const current = async () => {
        const response = await fetch('/api/auth/session', { headers, cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
        if (response.status !== 200) return false;
        const value = await response.json();
        return value.userId === expected.userId && value.deviceId === expected.deviceId && value.admin === false;
      };
      if (!await current()) return 0;
      const response = await fetch('/livekit/sfu/rtc/validate', {
        method: 'GET', headers: { ...headers, Authorization: 'Bearer ' + jwt },
        cache: 'no-store', credentials: 'same-origin', redirect: 'error',
      });
      return await current() ? response.status : 0;
    }, { expected: { userId: owner.userId, deviceId: owner.deviceId }, jwt: token }), 'SFU grant validation');
    pageOrigin(page); await session(page);
    requireProof(status === 200, 'The real SFU must accept the scoped grant without a participant join.');
  }
  // Verify both owners before issuing any disposable credential.
  await scope(alice); await scope(bob);
  const minted = new Set();
  for (const page of [alice, bob]) for (const modern of [false, true]) {
    const owner = await scope(page);
    const openid = await request(page, '/_matrix/client/v3/user/' + encodeURIComponent(owner.userId) + '/openid/request_token', {}, true);
    requireProof(openid?.status === 200 && object(openid.data) && typeof openid.data.access_token === 'string'
      && openid.data.access_token.length > 0 && openid.data.access_token.length <= 4096
      && openid.data.token_type === 'Bearer' && openid.data.matrix_server_name === 'chat.example.test'
      && Number.isSafeInteger(openid.data.expires_in) && openid.data.expires_in > 0 && openid.data.expires_in <= 86400,
    'Each RTC exchange requires a fresh native OpenID credential.');
    requireProof(!minted.has(openid.data.access_token), 'RTC exchanges must not reuse native OpenID credentials.'); minted.add(openid.data.access_token);
    await scope(page);
    const member = 'ci-auth-' + randomBytes(12).toString('hex');
    const body = modern ? { room_id: roomId, slot_id: 'm.call#ROOM', member: {
      id: member, claimed_user_id: owner.userId, claimed_device_id: owner.deviceId,
    }, openid_token: openid.data } : { room: roomId, device_id: owner.deviceId, openid_token: openid.data };
    const result = await request(page, modern ? '/livekit/jwt/get_token' : '/livekit/jwt/sfu/get', body);
    await session(page);
    const token = proveToken(result, roomId, owner, member, modern);
    await validate(page, owner, token);
  }
  const owner = await scope(alice);
  const rejected = await request(alice, '/livekit/jwt/sfu/get', { room: roomId, device_id: owner.deviceId,
    openid_token: { access_token: 'ci-invalid-' + randomBytes(24).toString('hex'), token_type: 'Bearer', matrix_server_name: 'chat.example.test', expires_in: 60 } });
  await session(alice);
  requireProof(rejected?.status === 403, 'RTC exchange must reject invalid OpenID credentials with HTTP 403.');
  console.log('PASS: both ordinary CI accounts exchange fresh native OpenID credentials through both RTC token endpoints; the public SFU validates each scoped grant without joining a call, and invalid OpenID is rejected.');
}
