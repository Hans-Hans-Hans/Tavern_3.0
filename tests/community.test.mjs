import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
let client;
const community = loadTs('../lib/community.ts', { './matrix': { getMatrixClient: () => client }, './roles': {} });
const { normalizeProfile, normalizeServerLayout, moveChannel, normalizeChannelAppearance, cleanMxc } = community;
test('profile links reject scripts, credentials, and non-web schemes', () => {
  const profile = normalizeProfile({ links: [{ url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.com' }, { url: 'data:text/html,no' }, { url: 'https://example.com', label: 'Safe' }] });
  assert.deepEqual(profile.links, [{ url: 'https://example.com/', label: 'Safe' }]);
});
test('profile expiration hides status and invalid metadata is bounded', () => {
  const profile = normalizeProfile({ status: 'Expired', statusEmoji: '👋', statusUntil: 100, bio: 'x'.repeat(2000), timezone: 'invalid/timezone', accent: 'red;position:fixed', avatar: 'https://tracker.example.com/avatar' }, 101);
  assert.equal(profile.status, ''); assert.equal(profile.statusEmoji, ''); assert.equal(profile.bio.length, 1000); assert.equal(profile.timezone, ''); assert.equal(profile.accent, ''); assert.equal(profile.avatar, '');
});
test('profile custom fields and language are bounded, normalized text', () => { const profile = normalizeProfile({ language: 'en-us', fields: [{ label: 'Office', value: 'Remote' }, { label: '', value: 'Incomplete' }, { label: 'Long', value: 'x'.repeat(400) }] }); assert.equal(profile.language, 'en-US'); assert.equal(profile.fields.length, 2); assert.equal(profile.fields[1].value.length, 300); assert.equal(normalizeProfile({ language: 'invalid language!' }).language, ''); });
test('status Today and This week clear at calendar boundaries instead of rolling durations', () => { const now = new Date(2026, 8, 8, 12, 30).getTime(); const today = new Date(community.profileStatusExpiration('today', 0, now)); assert.equal(today.getDate(), 9); assert.equal(today.getHours(), 0); const week = new Date(community.profileStatusExpiration('week', 0, now)); assert.equal(week.getDay(), 1); assert.equal(week.getHours(), 0); assert.equal(community.profileStatusExpiration('keep', 123, now), 123); assert.throws(() => community.profileStatusExpiration('invalid', 0, now)); });
test('layout excludes unrelated channels and deduplicates categories and channels', () => {
  const layout = normalizeServerLayout({ categories: [{ id: 'c', name: 'Chat' }, { id: 'c', name: 'Duplicate' }], channels: [{ id: '!a:local', category: 'c' }, { id: '!a:local', category: '' }, { id: '!b:local', category: 'missing' }, { id: '!secret:local', category: 'c' }] }, ['!a:local', '!b:local', '!new:local']);
  assert.deepEqual(layout.categories, [{ id: 'c', name: 'Chat', icon: '' }]); assert.deepEqual(layout.channels, [{ id: '!a:local', category: 'c' }, { id: '!b:local', category: '' }, { id: '!new:local', category: '' }]);
});
test('moving a channel retains all members and rejects unknown category', () => {
  const old = normalizeServerLayout({ categories: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], channels: [{ id: '!one:x', category: 'a' }, { id: '!two:x', category: 'b' }] });
  const next = moveChannel(old, '!one:x', 'b', '!two:x'); assert.deepEqual(next.channels, [{ id: '!one:x', category: 'b' }, { id: '!two:x', category: 'b' }]); assert.equal(old.channels[0].category, 'a'); assert.throws(() => moveChannel(old, '!one:x', 'gone')); assert.throws(() => moveChannel(old, '!foreign:x', 'a'));
});
test('untrusted appearance cannot inject CSS or an external image', () => { assert.equal(normalizeChannelAppearance({ accent: 'url(https://tracker)' }).accent, ''); assert.equal(cleanMxc('mxc://server/media'), 'mxc://server/media'); assert.equal(cleanMxc('mxc://server/media?token=secret'), ''); });
test('server layout writes deny users without server authority before sending', async () => {
  let sent = false; client = { getUserId: () => '@member:local', getRoom: () => ({ getMyMembership: () => 'join', isSpaceRoom: () => true, currentState: { maySendStateEvent: () => false } }), sendStateEvent: () => { sent = true; } };
  await assert.rejects(community.saveServerLayout('!server:local', normalizeServerLayout({})), /permission/); assert.equal(sent, false);
});
test('member profile write preserves membership and always addresses authenticated user', async () => {
  const writes = []; const room = { getMyMembership: () => 'join', isSpaceRoom: () => true };
  client = { getUserId: () => '@self:local', getRoom: () => room, getStateEvent: async (...args) => { assert.equal(args[2], '@self:local'); return { membership: 'join', third_party_invite: { signed: 'preserve' } }; }, sendStateEvent: async (...args) => writes.push(args) };
  await community.saveOwnProfile(normalizeProfile({ name: 'Nickname' }), '!server:local'); assert.equal(writes[0][1], 'm.room.member'); assert.equal(writes[0][3], '@self:local'); assert.equal(writes[0][2].membership, 'join'); assert.equal(writes[0][2].displayname, 'Nickname'); assert.equal(writes[0][2]['io.tavern.profile'].serverOverride, '!server:local'); assert.deepEqual(writes[0][2].third_party_invite, { signed: 'preserve' });
});
