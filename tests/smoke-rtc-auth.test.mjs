// These are orchestration/guard tests. The mounted smoke performs the native
// OpenID, issuer and real SFU HTTP checks in the assembled Linux CI stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { rtcAuthSmoke } from '../scripts/smoke-rtc-auth.mjs';

const origin = 'https://chat.example.test';
const aliceSession = { userId: '@cialice:chat.example.test', deviceId: 'CI_ALICE', admin: false };
const bobSession = { userId: '@cibob:chat.example.test', deviceId: 'CI_BOB', admin: false };
const nativeId = '!Nhcu5BS-UMnFX7hBVfVSoXiD7OgH6iRT-xyIuqDnpYQ';
const roomHash = tuple => createHash('sha256').update(JSON.stringify(tuple)).digest('base64').replace(/=+$/, '');
function jwt(payload, header = { alg: 'HS256', typ: 'JWT' }) {
  const message = Buffer.from(JSON.stringify(header)).toString('base64url') + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  return message + '.' + createHmac('sha256', 'semantic-fixture-only').update(message).digest('base64url');
}
async function ci(run) {
  const before = { TAVERN_CI_SMOKE: process.env.TAVERN_CI_SMOKE, TAVERN_CI_TLS: process.env.TAVERN_CI_TLS };
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/tavern-ci-tls';
  try { await run(); } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
function fixture({ roomId = nativeId, changeState, beforeApi, changeExchange, changeOpenid, beforeValidate, validationStatus = 200, negativeStatus = 403 } = {}) {
  const calls = [], browserCalls = [], owners = new Map(); let mints = 0;
  const events = [
    { type: 'm.room.create', state_key: '', sender: aliceSession.userId, content: { 'm.federate': false, ...(roomId.includes(':') ? {} : { room_version: '12' }) } },
    { type: 'm.room.name', state_key: '', content: { name: 'CI encrypted conversation' } },
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
    { type: 'm.room.power_levels', state_key: '', content: { events: { 'org.matrix.msc3401.call.member': 0 } } },
    ...[aliceSession, bobSession].map(owner => ({ type: 'm.room.member', state_key: owner.userId, content: { membership: 'join' } })),
  ];
  function page(owner) {
    const context = {}, page = { url: () => origin, context: () => context };
    owners.set(page, { ...owner });
    // Execute the actual dedicated browser callback with a controlled fetch
    // boundary; no arbitrary query, media, WebSocket or participant API exists.
    page.evaluate = async (fn, args) => {
      if (beforeValidate) beforeValidate({ page, owners, args });
      return runInNewContext('(' + fn.toString() + ')', {
        location: { origin },
        fetch: async (path, options) => {
          browserCalls.push({ page, path, options });
          if (path === '/api/auth/session') return { status: 200, json: async () => ({ ...owners.get(page) }) };
          if (path === '/livekit/sfu/rtc/validate') return { status: validationStatus };
          throw new Error('Unexpected browser fixture path.');
        },
      })(args);
    };
    return page;
  }
  const alice = page(aliceSession), bob = page(bobSession);
  const base = { alice, bob, aliceSession, bobSession, origin, roomId, api: async (page, path, body, matrix) => {
    const call = { page, path, body, matrix }; calls.push(call);
    if (beforeApi) await beforeApi({ call, owners, events, mints });
    const owner = owners.get(page);
    if (path === '/api/auth/session') return { status: 200, data: { ...owner } };
    if (path === '/_matrix/client/v3/account/whoami') return { status: 200, data: { user_id: owner.userId, device_id: owner.deviceId } };
    if (path === '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/state') {
      const value = structuredClone(events); if (changeState) changeState(value);
      return { status: 200, data: value };
    }
    if (path === '/_matrix/client/v3/user/' + encodeURIComponent(owner.userId) + '/openid/request_token') {
      const data = { access_token: 'fixture-openid-' + ++mints, token_type: 'Bearer', matrix_server_name: 'chat.example.test', expires_in: 3600 };
      if (changeOpenid) changeOpenid(data);
      return { status: 200, data };
    }
    if (path === '/livekit/jwt/sfu/get' || path === '/livekit/jwt/get_token') {
      if (body.openid_token.access_token.startsWith('ci-invalid-')) return { status: negativeStatus, data: { error: 'Invalid OpenID.' } };
      const modern = path.endsWith('get_token'), now = Math.floor(Date.now() / 1000);
      const claims = { iss: 'fixture-key', nbf: now - 5, exp: now + 300,
        sub: modern ? roomHash([owner.userId, owner.deviceId, body.member.id]) : owner.userId + ':' + owner.deviceId,
        video: { roomJoin: true, room: roomHash([roomId, 'm.call#ROOM']), canPublish: true, canSubscribe: true },
      };
      const result = { status: 200, data: { url: 'wss://chat.example.test/livekit/sfu', jwt: jwt(claims) } };
      if (changeExchange) changeExchange({ result, claims, call });
      return result;
    }
    throw new Error('Unexpected native fixture path.');
  } };
  return { base, calls, browserCalls, owners, events };
}

test('RTC probe rejects environment, accounts, unsafe IDs and shared browsers before native requests', () => ci(async () => {
  const { base, calls } = fixture();
  for (const patch of [
    { origin: 'https://production.example' }, { roomId: '!real:production.example' },
    { roomId: nativeId + '=' }, { api: undefined },
    { aliceSession: { ...aliceSession, admin: true } }, { bobSession: { ...bobSession, userId: aliceSession.userId } },
    { bobSession: { ...bobSession, deviceId: '' } },
  ]) await assert.rejects(rtcAuthSmoke({ ...base, ...patch }), /exact isolated CI/);
  await assert.rejects(rtcAuthSmoke({ ...base, bob: base.alice }), /own browser contexts/);
  process.env.TAVERN_CI_SMOKE = 'false'; await assert.rejects(rtcAuthSmoke(base), /exact isolated CI/);
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/unrelated';
  await assert.rejects(rtcAuthSmoke(base), /exact isolated CI/);
  assert.equal(calls.length, 0);
}));

test('RTC probe proves native room ownership, exact encryption, version and both memberships before minting', () => ci(async () => {
  for (const changeState of [
    events => { events[0].sender = '@ciadmin:chat.example.test'; },
    events => { events[0].content['m.federate'] = true; },
    events => { events[0].content.room_version = '11'; },
    events => { events[0].content.type = 'm.space'; },
    events => { events[0].content.additional_creators = [bobSession.userId]; },
    events => { events[1].content.name = 'Another room'; },
    events => { events[2].content.algorithm = 'unencrypted'; },
    events => { events[4].content.events['org.matrix.msc3401.call.member'] = 50; },
    events => { events.at(-1).content.membership = 'leave'; },
    events => { events.push({ ...events.at(-1), state_key: '@other:chat.example.test' }); },
    events => { events.push(structuredClone(events[0])); },
    events => { events[0].room_id = '!another:chat.example.test'; },
    events => { events.push({ type: 'm.space.parent', state_key: '!parent:chat.example.test', content: { canonical: true } }); },
  ]) {
    const { base, calls } = fixture({ changeState });
    await assert.rejects(rtcAuthSmoke(base), /RTC fixture/);
    assert.equal(calls.some(call => call.body !== undefined), false);
  }
}));

test('both native room-ID forms perform four fresh exchanges and header-only SFU validations without joining', () => ci(async () => {
  for (const roomId of [nativeId, '!legacy-ci:chat.example.test']) {
    const { base, calls, browserCalls } = fixture({ roomId }); await rtcAuthSmoke(base);
    const exchanges = calls.filter(call => call.path.startsWith('/livekit/jwt/'));
    const issued = exchanges.filter(call => !call.body.openid_token.access_token.startsWith('ci-invalid-'));
    assert.deepEqual(issued.map(call => call.path), ['/livekit/jwt/sfu/get', '/livekit/jwt/get_token', '/livekit/jwt/sfu/get', '/livekit/jwt/get_token']);
    assert.equal(new Set(issued.map(call => call.body.openid_token.access_token)).size, 4);
    assert.deepEqual(issued.map(call => call.page), [base.alice, base.alice, base.bob, base.bob]);
    for (const call of issued) {
      assert.equal(call.matrix, false);
      const id = call.page === base.alice ? aliceSession : bobSession;
      if (call.path.endsWith('get_token')) {
        assert.equal(call.body.room_id, roomId); assert.equal(call.body.slot_id, 'm.call#ROOM');
        assert.equal(call.body.member.claimed_user_id, id.userId); assert.equal(call.body.member.claimed_device_id, id.deviceId);
      } else { assert.equal(call.body.room, roomId); assert.equal(call.body.device_id, id.deviceId); }
    }
    const validations = browserCalls.filter(call => call.path === '/livekit/sfu/rtc/validate');
    assert.equal(validations.length, 4);
    for (const call of validations) {
      assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'error');
      assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.cache, 'no-store');
      assert.match(call.options.headers.Authorization, /^Bearer [A-Za-z0-9_.-]+$/);
      assert.equal(call.options.headers['X-Tavern-Device'], call.page === base.alice ? aliceSession.deviceId : bobSession.deviceId);
    }
    assert.equal([...calls, ...browserCalls].some(call => call.path.includes('?') || /\/join|\/send\//.test(call.path)), false);
    assert.equal(exchanges.length, 5); assert.equal(exchanges.at(-1).path, '/livekit/jwt/sfu/get');
  }
}));

test('owner or native membership changing during OpenID issuance prevents the token exchange', () => ci(async () => {
  for (const mutate of [
    ({ call, owners }) => owners.set(call.page, { ...bobSession }),
    ({ events }) => { events.at(-1).content.membership = 'leave'; },
  ]) {
    const { base, calls } = fixture({ beforeApi: value => { if (value.call.path.endsWith('/openid/request_token')) mutate(value); } });
    await assert.rejects(rtcAuthSmoke(base), /session changed|native OpenID|RTC fixture|transport failed/);
    assert.equal(calls.some(call => call.path.startsWith('/livekit/')), false);
  }
}));

test('wrong or overbroad grants and internal URLs fail without echoing token claims', () => ci(async () => {
  const secret = 'DO_NOT_PRINT_THIS_CREDENTIAL';
  for (const changeExchange of [
    ({ result }) => { result.data.url = 'http://livekit:7880'; },
    ({ result }) => { result.data.url = 'wss://foreign.example/' + secret; },
    ({ result, claims }) => { result.data.jwt = jwt({ ...claims, sub: secret }); },
    ({ result, claims }) => { result.data.jwt = jwt({ ...claims, video: { ...claims.video, room: secret } }); },
    ({ result, claims }) => { result.data.jwt = jwt({ ...claims, video: { ...claims.video, roomAdmin: true } }); },
    ({ result, claims }) => { result.data.jwt = jwt({ ...claims, exp: 1 }); },
    ({ result, claims }) => { result.data.jwt = jwt(claims, { alg: 'none' }); },
    ({ result }) => { result.data.jwt = secret; },
    ({ result }) => { result.status = 503; result.data = { error: secret }; },
  ]) {
    const { base, browserCalls } = fixture({ changeExchange });
    await assert.rejects(rtcAuthSmoke(base), error => /RTC/.test(error.message) && !error.message.includes(secret));
    assert.equal(browserCalls.length, 0);
  }
}));

test('real SFU validation is required and ownership is rechecked inside its browser callback', () => ci(async () => {
  const rejected = fixture({ validationStatus: 401 });
  await assert.rejects(rtcAuthSmoke(rejected.base), /real SFU must accept/);
  assert.equal(rejected.calls.filter(call => call.path.startsWith('/livekit/jwt/')).length, 1);
  const changed = fixture({ beforeValidate: ({ page, owners }) => { owners.set(page, { ...bobSession }); } });
  await assert.rejects(rtcAuthSmoke(changed.base), /session changed/);
  assert.equal(changed.browserCalls.some(call => call.path === '/livekit/sfu/rtc/validate'), false);
}));

test('failed exchange diagnostics expose only bounded HTTP status and allowlisted categories', () => ci(async () => {
  for (const code of ['CALL_OPENID_UNAVAILABLE', 'CALL_OPENID_REJECTED', 'CALL_ISSUER_OPENID_REJECTED', 'CALL_SFU_ROOM_CREATION_FAILED', 'CALL_ISSUER_UNAVAILABLE', 'CALL_ACCESS_DENIED']) {
    const value = fixture({ changeExchange: ({ result }) => { result.status = 503; result.data = { errcode: code, error: 'SECRET_BODY' }; } });
    await assert.rejects(rtcAuthSmoke(value.base), error => error.message === 'RTC token exchange must return HTTP 200 (status=503, code=' + code + ').');
  }
  const value = fixture({ changeExchange: ({ result }) => { result.status = 'SECRET_STATUS'; result.data = { errcode: 'SECRET_CODE', error: 'SECRET_BODY' }; } });
  await assert.rejects(rtcAuthSmoke(value.base), error => error.message === 'RTC token exchange must return HTTP 200 (status=unknown, code=unclassified).');
}));

test('native credential shape/reuse, invalid-token acceptance and transport errors cannot yield a false pass', () => ci(async () => {
  const malformed = fixture({ changeOpenid: data => { data.matrix_server_name = 'foreign.example'; } });
  await assert.rejects(rtcAuthSmoke(malformed.base), /fresh native OpenID/);
  assert.equal(malformed.calls.some(call => call.path.startsWith('/livekit/jwt/')), false);
  const reused = fixture({ changeOpenid: data => { data.access_token = 'same-openid'; } });
  await assert.rejects(rtcAuthSmoke(reused.base), /must not reuse/);
  assert.equal(reused.calls.filter(call => call.path.startsWith('/livekit/jwt/')).length, 1);
  const negative = fixture({ negativeStatus: 200 }); await assert.rejects(rtcAuthSmoke(negative.base), /invalid OpenID credentials with HTTP 403/);
  const unsafe = fixture({ beforeApi: () => { throw new Error('DO_NOT_PRINT_NATIVE_BODY_OR_TOKEN'); } });
  await assert.rejects(rtcAuthSmoke(unsafe.base), error => error.message === 'RTC authentication transport failed during session verification.');
}));
