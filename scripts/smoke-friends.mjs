import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function friendsSmoke({ alice, bob, aliceSession, bobSession, origin, api, ready }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls' || origin !== 'https://chat.example.test'
    || aliceSession.userId !== '@cialice:chat.example.test' || bobSession.userId !== '@cibob:chat.example.test'
    || aliceSession.admin || bobSession.admin || alice.context() === bob.context()) throw new Error('Friend acceptance requires the isolated owning accounts.');
  for (const [page, owner] of [[alice, aliceSession], [bob, bobSession]]) {
    assert.equal(new URL(page.url()).origin, origin);
    const current = await api(page, '/api/auth/session'); assert.equal(current.status, 200);
    for (const field of ['userId', 'deviceId', 'admin']) assert.equal(current.data[field], owner[field]);
  }
  const state = async page => { const response = await api(page, '/api/social'); assert.equal(response.status, 200); return response.data; };
  const original = await state(bob);
  assert.match(original.friendCode, /^TAV-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(original.requests.length, 0, 'Use fresh fixture accounts.');
  await alice.goto(origin + '/#view=friends'); await ready(alice);
  const panel = alice.locator('.friends-workspace');
  await panel.getByLabel('Friend code', { exact: true }).fill(original.friendCode);
  await panel.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Friend request sent');
  const request = (await state(bob)).requests.find(row => row.sender === aliceSession.userId && row.status === 'pending');
  assert.ok(request, 'A native pending request must belong to the code owner.');
  const forged = await api(alice, '/api/social/requests/' + request.id, { operation: 'accept' }, false, false, 'PATCH');
  assert.equal(forged.status, 403, 'Only the recipient accepts.');
  await bob.goto(origin + '/#view=friends'); await ready(bob);
  await bob.locator('.friends-workspace').getByRole('button', { name: 'Pending (1)', exact: true }).click();
  await bob.getByRole('region', { name: 'Received', exact: true }).getByRole('button', { name: 'Accept', exact: true }).click();
  await expect.poll(async () => (await state(alice)).requests.find(row => row.id === request.id)?.status).toBe('accepted');
  const rotated = await api(bob, '/api/social/friend-code', { previousCode: original.friendCode });
  assert.equal(rotated.status, 200); assert.notEqual(rotated.data.friendCode, original.friendCode);
  const revoked = await api(alice, '/api/social/requests', { target: original.friendCode }); assert.equal(revoked.status, 400);
  await bob.reload(); await ready(bob);
  await expect(bob.locator('.friends-workspace').getByRole('textbox', { name: 'Your friend code', exact: true })).toHaveValue(rotated.data.friendCode);
  assert.equal((await state(bob)).requests.find(row => row.id === request.id)?.status, 'accepted');
  assert.equal((await api(alice, '/api/social/contacts/' + encodeURIComponent(bobSession.userId), undefined, false, false, 'DELETE')).status, 200);
  assert.equal((await state(bob)).requests.length, 0);
  console.log('PASS: real friend-code UI creates an account-owned request, recipient acceptance persists, code replacement revokes discovery without removing friendship, and reload restores the new code.');
}
