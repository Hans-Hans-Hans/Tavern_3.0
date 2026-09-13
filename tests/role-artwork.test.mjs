import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const roles = loadTs('../lib/roles.ts', { './api': {}, './conference-publication': loadTs('../lib/conference-publication.ts', {}), './matrix': {} });
const { memberRolePresentation } = loadTs('../lib/role-presentation.ts', { './roles': roles });
const { roleCopy } = loadTs('../lib/role-editor.ts', { './roles': roles });

test('role artwork accepts bounded Matrix media references and rejects external or malformed images', () => {
  const policy = roles.defaultRolePolicy('@owner:local');
  for (const iconMxc of ['mxc://local/artwork', 'mxc://example.org:8448/a-b_C', '']) {
    policy.roles[0].iconMxc = iconMxc;
    assert.equal(roles.parseRolePolicy(policy).roles[0].iconMxc, iconMxc);
  }
  for (const invalid of [null, 3, {}, 'https://tracker/pixel', 'data:image/png;base64,AAA', 'mxc://local/a?token=private', 'mxc://local/a/b', 'mxc://local/a\u0000', 'mxc://local/' + 'a'.repeat(1024)]) {
    policy.roles[0].iconMxc = invalid;
    assert.equal(roles.parseRolePolicy(policy), null);
  }
  delete policy.roles[0].iconMxc;
  assert.ok(roles.parseRolePolicy(policy));
});

test('artwork follows icon hierarchy independently from color and survives role duplication', () => {
  const policy = roles.defaultRolePolicy('@owner:local');
  policy.roles.push({ id: 'image', name: 'Artists', position: 30, permissions: [], color: '', icon: '🎨', iconMxc: 'mxc://local/artwork', separate: false, mentionable: false },
    { id: 'lower', name: 'Helpers', position: 10, permissions: [], color: '#6699ff', icon: '🌱', separate: false, mentionable: false });
  policy.members['@member:local'] = ['image', 'lower'];
  const identity = memberRolePresentation(policy, '@member:local');
  assert.equal(identity.iconRole.id, 'image'); assert.equal(identity.color, '#6699ff');
  const copy = roleCopy(policy, 1001, 'copy', policy.roles[1]);
  assert.equal(copy.iconMxc, 'mxc://local/artwork'); assert.equal(copy.icon, '🎨');
  assert.deepEqual(copy.permissions, []); assert.equal(copy.mentionable, false);
  policy.roles[1].icon = ''; policy.roles[1].iconMxc = '';
  assert.equal(memberRolePresentation(policy, '@member:local').iconRole.id, 'lower');
});
