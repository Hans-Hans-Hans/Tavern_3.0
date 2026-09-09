import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

const { validInvitationName, invitationToken, clearInvitationUrl, customInvitationUrl } = loadTs('../lib/invitation-link.ts');
const read = href => invitationToken(new URL(href, 'https://tavern.test'));

test('custom invitation names are bounded canonical path segments', () => {
  for (const name of ['guild-night', 'abc', '123', 'a'.repeat(48)]) assert.equal(validInvitationName(name), true);
  for (const name of ['ab', 'Abc', '-abc', 'abc-', 'a--b', 'a'.repeat(49), 'a/b', 'a%2Fb', 'admin', 'api', 'a_b', true, null]) assert.equal(validInvitationName(name), false);
  assert.equal(customInvitationUrl('guild-night', 'https://tavern.test'), 'https://tavern.test/invite/guild-night');
});

test('custom paths and existing opaque query invitations share the same auth handle', () => {
  const token = 'A_'.repeat(22);
  assert.equal(read('/invite/guild-night?recovery=kept#room=other'), 'v:guild-night');
  assert.equal(read('/invite/guild-night/'), 'v:guild-night');
  assert.equal(read('/?invite=' + token + '&next=kept'), token);
  assert.equal(read('/?invite=v%3Aguild-night'), 'v:guild-night');
  assert.equal(read('/invite/guild-night?invite=' + token), token);
  for (const path of ['/invite/admin', '/invite/Abc', '/invite/a%2Fb', '/invite/guild-night/extra', '/?invite=', '/?invite=short', '/?invite=' + token + '&invite=' + token]) assert.equal(read(path), '');
});

test('closing an invite preserves auth/recovery query parameters and room hash', () => {
  assert.equal(clearInvitationUrl('https://tavern.test/invite/guild-night?recovery=kept&other=1#room=xyz'), 'https://tavern.test/?recovery=kept&other=1#room=xyz');
  assert.equal(clearInvitationUrl('https://tavern.test/?invite=' + 'a'.repeat(43) + '&recovery=kept#room=xyz'), 'https://tavern.test/?recovery=kept#room=xyz');
  assert.equal(clearInvitationUrl('https://tavern.test/admin?invite=' + 'a'.repeat(43) + '&other=1'), 'https://tavern.test/admin?other=1');
});
