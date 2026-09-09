import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

const V12 = '!Nhcu5BS-UMnFX7hBVfVSoXiD7OgH6iRT-xyIuqDnpYQ';
function fixture() {
  const owner = {}, client = { getUserId: () => '@alice:test' }, writes = [];
  let stored = { servers: { [V12]: 'contacts' }, invalid: false, revision: 'a'.repeat(64), invitations: 'everyone' };
  const model = loadTs('../lib/server-invitation-privacy.ts', {
    './matrix': { getMatrixClient: () => client },
    './api': { accountArtworkOwner: () => owner, isManagedAccount: () => true, requestApi: async (path, body, method) => {
      assert.equal(path, '/social/server-invitation-privacy');
      if (method === 'PUT') { writes.push(structuredClone(body)); assert.equal(body.revision, stored.revision); stored = { ...stored, servers: structuredClone(body.servers), revision: 'b'.repeat(64) }; }
      return structuredClone(stored);
    } },
  });
  return { model, writes };
}

test('v12 saved preferences remain editable and send the original revision and exact selected map', async () => {
  const { model, writes } = fixture();
  const previous = await model.serverInvitationPrivacy();
  assert.deepEqual(previous.servers, { [V12]: 'contacts' });
  const saved = await model.serverInvitationPrivacy({ [V12]: 'nobody', '!legacy:test': 'contacts' }, previous);
  assert.deepEqual(writes, [{ servers: { [V12]: 'nobody', '!legacy:test': 'contacts' }, revision: 'a'.repeat(64) }]);
  assert.equal(saved.invitations, 'everyone');
  assert.equal(saved.invalid, false);
});

test('canonical 32-byte hashes accept all final byte values while nonzero padding bits and malformed keys deny', async () => {
  const { model, writes } = fixture();
  for (let final = 0; final < 256; final++) {
    const bytes = Buffer.alloc(32); bytes[31] = final;
    assert.equal(model.validServerInvitationRules({ ['!' + bytes.toString('base64url')]: 'contacts' }), true);
  }
  const previous = await model.serverInvitationPrivacy();
  for (const key of ['!short', '!' + 'A'.repeat(42), '!' + 'A'.repeat(44), '!' + 'A'.repeat(42) + 'B', V12 + '=', V12 + '/state', V12 + '\n', V12 + '\0']) {
    assert.equal(model.validServerInvitationRules({ [key]: 'nobody' }), false, key);
    await assert.rejects(model.serverInvitationPrivacy({ [key]: 'nobody' }, previous), /up to 200/);
    assert.throws(() => model.parseServerInvitationPrivacy({ ...previous, servers: { [key]: 'nobody' } }), /incomplete invitation/);
  }
  assert.deepEqual(writes, []);
});

test('mixed legacy and v12 scopes retain the 200-rule cap and restriction-only modes', () => {
  const { model } = fixture();
  const rules = Object.fromEntries(Array.from({ length: 199 }, (_, i) => ['!s' + i + ':test', 'contacts']));
  rules[V12] = 'nobody';
  assert.equal(model.validServerInvitationRules(rules), true);
  assert.equal(model.validServerInvitationRules({ ...rules, ['!' + 'A'.repeat(43)]: 'contacts' }), false);
  for (const mode of ['everyone', 'shared_server', null, true, [], {}]) assert.equal(model.validServerInvitationRules({ [V12]: mode }), false);
  for (const invalid of [null, [], true, '']) assert.equal(model.validServerInvitationRules(invalid), false);
});
