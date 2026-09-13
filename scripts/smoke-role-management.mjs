// Real role editor on the already-proved native moderation fixture.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { assertCiRoomCreation, isCiRoomId } from './ci-room-id.mjs';
import { matrixSmokeRequest } from './matrix-smoke-request.mjs';
import { openSystemMessageSettings } from './smoke-system-messages.mjs';

const ORIGIN = 'https://chat.example.test', ADMIN = '@ciadmin:chat.example.test', ALICE = '@cialice:chat.example.test', BOB = '@cibob:chat.example.test';
const TYPE = 'io.tavern.roles';
export async function roleManagementSmoke({ admin, alice, adminSession, aliceSession, serverId, serverName, runId, origin, api }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls' || origin !== ORIGIN
    || adminSession?.userId !== ADMIN || adminSession.admin !== true || !adminSession.deviceId
    || aliceSession?.userId !== ALICE || aliceSession.admin !== false || !aliceSession.deviceId
    || !isCiRoomId(serverId) || !/^[a-f0-9]{24}$/.test(runId || '') || serverName !== 'CI member moderation server ' + runId || typeof api !== 'function') {
    throw new Error('Role management acceptance requires the exact isolated CI moderation fixture.');
  }
  assert.notEqual(admin.context(), alice.context(), 'Use distinct owning browser contexts.');
  async function session(page, expected) {
    assert.equal(new URL(page.url()).origin, ORIGIN);
    const response = await matrixSmokeRequest(() => api(page, '/api/auth/session'));
    assert.equal(response.status, 200);
    for (const key of ['userId', 'deviceId', 'admin']) assert.equal(response.data[key], expected[key], 'The owning role-editor account changed.');
  }
  async function inspect() {
    await session(admin, adminSession);
    const response = await matrixSmokeRequest(() => api(admin, '/_matrix/client/v3/rooms/' + encodeURIComponent(serverId) + '/state', undefined, true));
    assert.equal(response.status, 200);
    const find = assertCiRoomCreation({ id: serverId, events: response.data, creator: ADMIN, name: serverName, marker: 'io.tavern.ci_audio', runId, space: true });
    assert.equal(find('m.room.join_rules')?.content.join_rule, 'invite');
    for (const event of response.data.filter(event => event.type === 'm.room.member')) assert.ok([ADMIN, ALICE, BOB].includes(event.state_key));
    for (const user of [ADMIN, ALICE, BOB]) assert.equal(find('m.room.member', user)?.content.membership, 'join');
    const policy = find(TYPE); assert.ok(policy?.event_id && policy.content.owner === ADMIN);
    return policy;
  }
  await session(alice, aliceSession); const before = await inspect();
  const rolePath = '/rooms/' + serverId + '/state/' + TYPE;
  let acceptedWrites = 0;
  const responseListener = response => { if (response.status() === 200 && response.request().method() === 'PUT' && decodeURIComponent(new URL(response.url()).pathname).includes(rolePath)) acceptedWrites++; };
  admin.on('response', responseListener);
  try {
    await openSystemMessageSettings(admin, serverName);
    await admin.getByRole('dialog').getByRole('tab', { name: 'Roles', exact: true }).click();
    const editor = admin.locator('.server-roles-editor');
    await expect(editor.getByRole('heading', { name: 'Server roles and permissions' })).toBeVisible();
    await editor.getByRole('button', { name: 'Add role', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Role name', exact: true }).fill('CI helpers');
    await editor.getByRole('button', { name: 'Use role icon 🌱', exact: true }).click();
    await editor.getByRole('button', { name: 'Use role color #52b788', exact: true }).click();
    await editor.getByRole('tab', { name: 'Manage members', exact: true }).click();
    await editor.getByRole('button', { name: 'Select shown', exact: true }).click();
    await editor.getByRole('button', { name: 'Review 2 assignment changes', exact: true }).click();
    await admin.getByRole('button', { name: 'Update role draft', exact: true }).click();
    assert.equal(acceptedWrites, 0, 'Reviewing a bulk change must not write partial assignments.');
    await session(admin, adminSession);
    await editor.getByRole('button', { name: 'Save roles and permissions', exact: true }).click();
    await expect(editor.locator('.role-save-bar')).toContainText('No unsaved changes', { timeout: 60000 });
    const saved = await inspect(), created = saved.content.roles.find(role => role.name === 'CI helpers');
    assert.ok(created); assert.equal(created.icon, '🌱'); assert.equal(created.color, '#52b788');
    assert.equal(saved.content['io.tavern.previous_event'], before.event_id); assert.equal(acceptedWrites, 1);
    for (const user of [ALICE, BOB]) assert.deepEqual(new Set(saved.content.members[user]), new Set([...(before.content.members[user] || []), created.id]));
    await session(alice, aliceSession);
    const forged = await matrixSmokeRequest(() => api(alice, '/_matrix/client/v3/rooms/' + encodeURIComponent(serverId) + '/state/' + TYPE + '/',
      { ...saved.content, members: { ...saved.content.members, [ADMIN]: [created.id] }, 'io.tavern.previous_event': saved.event_id }, true, false, 'PUT'));
    assert.equal(forged.status, 403); assert.equal(forged.data.errcode, 'M_FORBIDDEN'); assert.equal((await inspect()).event_id, saved.event_id);
    await editor.getByRole('tab', { name: 'Display', exact: true }).click();
    await editor.getByRole('button', { name: 'Remove role', exact: true }).click();
    await expect(admin.getByRole('alertdialog')).toContainText('2 member assignments');
    await admin.getByRole('button', { name: 'Remove from draft', exact: true }).click();
    await session(admin, adminSession);
    await editor.getByRole('button', { name: 'Save roles and permissions', exact: true }).click();
    await expect(editor.locator('.role-save-bar')).toContainText('No unsaved changes', { timeout: 60000 });
    const removed = await inspect(); assert.ok(!removed.content.roles.some(role => role.id === created.id)); assert.equal(acceptedWrites, 2);
    for (const user of [ALICE, BOB]) assert.deepEqual(new Set(removed.content.members[user] || []), new Set(before.content.members[user] || []));
    await admin.keyboard.press('Escape'); await expect(admin.getByRole('dialog')).toHaveCount(0);
    console.log('PASS: the real role editor creates a styled role and assigns both native members in one revision-checked save; unauthorized elevation is rejected; reviewed removal preserves their other roles.');
  } finally { admin.off('response', responseListener); }
}
