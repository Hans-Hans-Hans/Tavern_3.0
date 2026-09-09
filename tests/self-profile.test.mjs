import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const profile = loadTs('../lib/self-profile.ts', { 'matrix-js-sdk/lib/http-api/method': { Method: { Get: 'GET' } } });

function fixture(user = null) {
  const f = { reads: [], user, value: { displayname: 'CI Bob', avatar_url: 'mxc://local/avatar' }, owned: true };
  f.client = { getUserId: () => '@bob:local', getUser: () => f.user, http: { authedRequest: async (...args) => { f.reads.push(args); if (f.beforeResponse) await f.beforeResponse(); return f.value; } } };
  return f;
}

test('native self profile survives missing User and hydrates only once without writes', async () => {
  const f = fixture();
  await Promise.all([profile.hydrateSelfProfile(f.client, () => f.owned), profile.hydrateSelfProfile(f.client, () => f.owned)]);
  assert.deepEqual(profile.nativeSelfProfile(f.client), { name: 'CI Bob', avatar: 'mxc://local/avatar' });
  assert.equal(f.reads.length, 1); assert.deepEqual(f.reads[0].slice(0, 2), ['GET', '/profile/%40bob%3Alocal']);
  assert.equal(f.reads[0][4].localTimeoutMs, 5000); assert.ok(f.reads[0][4].abortSignal instanceof AbortSignal);
});

test('native User placeholder is hydrated while a concurrent profile edit is preserved', async () => {
  const user = { displayName: '@bob:local', avatarUrl: '', setDisplayName(value) { this.displayName = value; }, setAvatarUrl(value) { this.avatarUrl = value; } };
  const f = fixture(user); await profile.hydrateSelfProfile(f.client, () => f.owned);
  assert.equal(user.displayName, 'CI Bob'); assert.equal(profile.nativeSelfProfile(f.client).name, 'CI Bob');
  user.setAvatarUrl(''); assert.equal(profile.nativeSelfProfile(f.client).avatar, '', 'A later native avatar removal must not revive the hydrated avatar');
  const other = fixture({ ...user }); other.beforeResponse = () => { other.user.displayName = 'Updated while loading'; };
  await profile.hydrateSelfProfile(other.client, () => other.owned);
  assert.equal(other.user.displayName, 'Updated while loading');
});

test('signout cancels hydration and stale responses cannot repopulate the profile', async () => {
  const f = fixture(); f.beforeResponse = () => { profile.clearSelfProfile(f.client); f.owned = false; };
  await profile.hydrateSelfProfile(f.client, () => f.owned);
  assert.equal(f.reads[0][4].abortSignal.aborted, true);
  assert.deepEqual(profile.nativeSelfProfile(f.client), { name: '@bob:local', avatar: '' });
});

test('a User created during hydration receives missing fields without replacing concurrent native updates', async () => {
  for (const updated of [false, true]) {
    const f = fixture(); f.beforeResponse = () => { f.user = { displayName: updated ? 'Fresh native name' : '@bob:local', avatarUrl: updated ? 'mxc://local/fresh' : '', setDisplayName(value) { this.displayName = value; }, setAvatarUrl(value) { this.avatarUrl = value; } }; };
    await profile.hydrateSelfProfile(f.client, () => f.owned);
    assert.deepEqual(profile.nativeSelfProfile(f.client), updated ? { name: 'Fresh native name', avatar: 'mxc://local/fresh' } : { name: 'CI Bob', avatar: 'mxc://local/avatar' });
  }
});

test('native profile failures do not prevent sign-in and returned metadata stays bounded', async () => {
  const f = fixture(); f.beforeResponse = () => { throw new Error('Unavailable'); };
  await profile.hydrateSelfProfile(f.client, () => true); assert.equal(profile.nativeSelfProfile(f.client).name, '@bob:local');
  const other = fixture(); other.value = { displayname: 'x'.repeat(1000), avatar_url: 'https://tracker.test/pixel' };
  await profile.hydrateSelfProfile(other.client, () => true);
  assert.equal(profile.nativeSelfProfile(other.client).name.length, 255); assert.equal(profile.nativeSelfProfile(other.client).avatar, '');
});
