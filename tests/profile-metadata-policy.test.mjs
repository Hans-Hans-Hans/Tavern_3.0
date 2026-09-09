import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
import { profileMetadataFixture } from './fixtures/profile-metadata.mjs';

function setup() {
  const f = profileMetadataFixture(), matrix = { getMatrixClient: () => f.client };
  const roles = loadTs('../lib/roles.ts', { './matrix': matrix });
  const channels = loadTs('../lib/channel-administration.ts', { './matrix': matrix, './roles': roles });
  f.api = loadTs('../lib/profile-metadata-policy.ts', { './matrix': matrix, './channel-administration': channels });
  f.community = loadTs('../lib/community.ts', { './matrix': matrix, './roles': roles, './profile-metadata-policy': f.api, './server-nickname': { serverNicknameForRoom: () => null }, './matrix-media': {}, './response-image': {}, './server-branding': {}, './self-profile': { nativeSelfProfile: () => ({ name: 'Global owner', avatar: '' }) } });
  f.rules = { ...f.api.emptyProfileMetadataPolicy(), enabled: true, allowLinks: false, maxBioLength: 160, maxStatusLength: 40 };
  f.profile = f.community.normalizeProfile({ name: 'Owner', bio: 'b'.repeat(500), status: 's'.repeat(80), links: [{ label: 'Homepage', url: 'https://example.com' }], fields: [{ label: 'Office', value: 'Remote' }] });
  return f;
}

test('profile rule schema has opt-in defaults, strict booleans, fixed ceilings and bounded opaque revisions', () => {
  const f = setup(), defaults = f.api.emptyProfileMetadataPolicy();
  assert.equal(f.api.profilePolicyForRoom(f.channel.roomId).enabled, false);
  for (const bad of [null, [], { ...defaults, enabled: 1 }, { ...defaults, maxBioLength: 161 }, { ...defaults, maxStatusLength: -1 }, { ...defaults, inspectMessages: true }, { ...defaults, 'io.tavern.previous_event': '$' }, { ...defaults, 'io.tavern.previous_event': '$bad space' }]) assert.equal(f.api.parseProfileMetadataPolicy(bad), null);
  assert.deepEqual(f.api.parseProfileMetadataPolicy({ ...defaults, 'io.tavern.previous_event': '$opaque/id?yes#fine' + 'x'.repeat(500) }), defaults);
});

test('saved policy without the required native CAS field is unavailable while a form draft remains valid', async () => {
  const f = setup();
  f.server.put(f.api.profileMetadataPolicyEvent, f.rules); delete f.server.currentState.getStateEvents(f.api.profileMetadataPolicyEvent, '').content['io.tavern.previous_event'];
  assert.deepEqual(f.api.parseProfileMetadataPolicy(f.rules), f.rules);
  assert.equal(f.api.readServerProfileMetadataPolicy(f.server.roomId), null);
  assert.equal(f.api.profilePolicyForRoom(f.channel.roomId).status, 'unavailable');
  await assert.rejects(f.api.checkProfileMetadataPublication(f.channel.roomId, f.profile, f.client, true), /unavailable/);
  assert.equal(f.writes.length, 0);
});

test('all reciprocal canonical parents and immutable private sources combine the strictest current profile limits', () => {
  const f = setup(); f.server.put(f.api.profileMetadataPolicyEvent, f.rules);
  const second = f.room('!second:local', 'm.space'); second.put(f.api.profileMetadataPolicyEvent, { ...f.rules, allowLinks: true, allowCustomFields: false, maxBioLength: 500, maxStatusLength: 0 });
  f.channel.put('m.space.parent', { canonical: true, via: ['local'] }, second.roomId); second.put('m.space.child', { via: ['local'] }, f.channel.roomId);
  const rules = f.api.profilePolicyForRoom(f.private.roomId);
  assert.equal(rules.status, 'ready'); assert.equal(rules.maxBioLength, 160); assert.equal(rules.maxStatusLength, 0); assert.equal(rules.allowLinks, false); assert.equal(rules.allowCustomFields, false);
  assert.deepEqual(rules.serverIds.sort(), [f.server.roomId, second.roomId].sort());
  second.put('m.space.child', {}, f.channel.roomId); assert.equal(f.api.profilePolicyForRoom(f.private.roomId).allowCustomFields, true);
  f.rooms.delete(second.roomId); assert.equal(f.api.profilePolicyForRoom(f.private.roomId).status, 'unavailable');
});

test('explicit application leaves original drafts intact, handles UTF16 limits, and current rendering does not claim to erase native metadata', () => {
  const f = setup(); f.server.put(f.api.profileMetadataPolicyEvent, { ...f.rules, maxStatusLength: 0 });
  f.profile.bio = 'x'.repeat(159) + '😀'; f.profile.statusEmoji = '😀';
  const rules = f.api.profilePolicyForRoom(f.server.roomId), copy = f.api.applyProfileMetadataPolicy(f.profile, rules);
  assert.equal(copy.bio.length, 159); assert.equal(copy.links.length, 0); assert.equal(copy.statusEmoji, ''); assert.equal(copy.statusUntil, 0);
  assert.equal(f.profile.links.length, 1); assert.equal(f.profile.bio.length, 161);
  f.channel.put('m.room.member', { membership: 'join', displayname: 'Identity retained', 'io.tavern.profile': f.profile }, f.actor);
  const shown = f.community.readMemberProfile(f.channel.roomId, f.actor);
  assert.equal(shown.name, 'Identity retained'); assert.equal(shown.links.length, 0); assert.equal(shown.bio.length, 159);
  assert.equal(f.channel.currentState.getStateEvents('m.room.member', f.actor).content['io.tavern.profile'].links.length, 1);
  f.server.put(f.api.profileMetadataPolicyEvent, { enabled: true }); assert.equal(f.community.readMemberProfile(f.channel.roomId, f.actor).bio, '');
});

test('an emoji-only status receives an explicit Apply action when server status is disabled', () => {
  const f = setup(); f.server.put(f.api.profileMetadataPolicyEvent, { ...f.rules, maxStatusLength: 0 });
  const draft = f.community.normalizeProfile({ name: 'Owner', status: '', statusEmoji: '🙂' }), rules = f.api.profilePolicyForRoom(f.server.roomId);
  assert.match(f.api.profileMetadataPolicyError(draft, rules), /Status and status emoji are disabled/);
  const applied = f.api.applyProfileMetadataPolicy(draft, rules);
  assert.equal(applied.statusEmoji, ''); assert.equal(f.api.profileMetadataPolicyError(applied, rules), null);
  assert.equal(draft.statusEmoji, '🙂');
});

test('direct server edits reject drafts; global saves project each room while preserving account data and server overrides', async () => {
  const f = setup(); f.server.put(f.api.profileMetadataPolicyEvent, f.rules);
  await assert.rejects(f.community.saveOwnProfile(f.profile, f.server.roomId), /draft has been kept/); assert.equal(f.writes.length, 0);
  const special = f.community.normalizeProfile({ name: 'Server nickname', bio: 'z'.repeat(500), links: f.profile.links });
  f.server.put('m.room.member', { membership: 'join', displayname: special.name, 'io.tavern.profile': { ...special, serverOverride: f.server.roomId } }, f.actor);
  await f.community.saveOwnProfile(f.profile);
  assert.deepEqual(f.account, f.profile); assert.equal(f.native.name, 'Owner');
  for (const write of f.writes) { assert.equal(write[3], f.actor); assert.equal(write[2]['io.tavern.profile'].links.length, 0); assert.ok(write[2]['io.tavern.profile'].bio.length <= 160); }
  const server = f.writes.find(write => write[0] === f.server.roomId)[2]; assert.equal(server.displayname, 'Server nickname'); assert.equal(server['io.tavern.profile'].serverOverride, f.server.roomId);
  assert.equal(f.writes.find(write => write[0] === f.channel.roomId)[2]['io.tavern.profile'].serverOverride, '');
  const reset = await f.community.resetServerProfile(f.server.roomId); assert.equal(reset.name, 'Owner'); assert.equal(reset.links.length, 0); assert.equal(reset.bio.length, 160); assert.deepEqual(f.account, f.profile);
});

test('fresh publication observes policy tightening, preserves membership data, and reports partial global failures accurately', async () => {
  const f = setup(); let changed = false;
  f.beforeRead = async identity => { if (!changed && identity === f.server.roomId) { changed = true; f.server.put(f.api.profileMetadataPolicyEvent, { ...f.rules, allowCustomFields: false }); } };
  await f.community.saveOwnProfile(f.profile);
  assert.ok(f.writes.every(write => write[2]['io.tavern.profile'].fields.length === 0));
  assert.deepEqual(f.writes[0][2].third_party_invite, { signed: 'preserved' });
  f.beforeRead = async identity => { if (identity === f.private.roomId) throw new Error('Private room cannot be checked.'); };
  await assert.rejects(f.community.saveOwnProfile(f.profile), /account profile was saved, but 1.*Private room cannot be checked/);
  assert.deepEqual(f.account, f.profile);
});

test('publisher never follows a replacement account or lost membership across state/global awaits', async () => {
  for (const change of ['account', 'membership', 'global']) {
    const f = setup(); const replace = () => { f.client = { ...f.client, sendStateEvent: async () => assert.fail('replacement account write') }; };
    if (change === 'global') { f.afterDisplayName = replace; await assert.rejects(f.community.saveOwnProfile(f.profile), /account changed/); assert.deepEqual(f.account, {}); }
    else { f.beforeRead = async () => { if (change === 'account') replace(); else f.server.membership = 'leave'; }; await assert.rejects(f.community.saveOwnProfile(f.profile, f.server.roomId), /changed/); }
    assert.equal(f.writes.length, 0);
  }
});

test('publication bounds parent fetches, rejects malformed private bindings and requires current source membership', async () => {
  const f = setup();
  for (let i = 0; i < 33; i++) f.channel.put('m.space.parent', { canonical: true, via: ['local'] }, `!parent${i}:local`);
  await assert.rejects(f.api.checkProfileMetadataPublication(f.channel.roomId, f.profile), /unavailable/); assert.deepEqual(f.reads, [f.channel.roomId]);
  const g = setup(); g.private.put('m.room.create', { type: 'io.tavern.private_thread' }); await assert.rejects(g.api.checkProfileMetadataPublication(g.private.roomId, g.profile), /unavailable/);
  const h = setup(); h.channel.put('m.room.member', { membership: 'leave' }, h.actor); await assert.rejects(h.api.checkProfileMetadataPublication(h.private.roomId, h.profile), /Join the conversation/);
});

test('policy writes require native and custom permission, preserve opaque CAS, and reject stale edits or account races', async () => {
  const f = setup(), defaults = f.api.emptyProfileMetadataPolicy();
  await f.api.saveProfileMetadataPolicy(f.server.roomId, f.rules, defaults); assert.equal(f.writes[0][2]['io.tavern.previous_event'], null);
  const saved = f.server.currentState.getStateEvents(f.api.profileMetadataPolicyEvent, ''), revision = saved.event_id;
  await assert.rejects(f.api.saveProfileMetadataPolicy(f.server.roomId, defaults, defaults), /rules changed/);
  await f.api.saveProfileMetadataPolicy(f.server.roomId, defaults, f.rules); assert.equal(f.writes[1][2]['io.tavern.previous_event'], revision);
  f.actor = '@member:local'; assert.equal(f.api.canManageProfileMetadataPolicy(f.server.roomId), false);
  await assert.rejects(f.api.saveProfileMetadataPolicy(f.server.roomId, f.rules, defaults), /permissions/);
  f.actor = '@owner:local'; f.beforeRead = async () => { f.client = { ...f.client }; };
  await assert.rejects(f.api.saveProfileMetadataPolicy(f.server.roomId, f.rules, defaults), /account/); assert.equal(f.writes.length, 2);
});
