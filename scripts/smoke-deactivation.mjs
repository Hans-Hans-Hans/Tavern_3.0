// Final acceptance step: only the isolated CI Bob account may be deactivated.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { matrixSmokeRequest } from './matrix-smoke-request.mjs';

export async function deactivationSmoke({ admin, alice, bob, aliceSession, bobSession, bobPassword, origin, api, ready }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || origin !== 'https://chat.example.test'
    || bobSession.userId !== '@cibob:chat.example.test' || bobSession.admin !== false) {
    throw new Error('Deactivation smoke requires the isolated CI Bob account.');
  }
  const detailPath = '/api/admin/users/' + encodeURIComponent(bobSession.userId);
  const details = async () => {
    const response = await matrixSmokeRequest(() => api(admin, detailPath));
    assert.equal(response.status, 200, 'The administrator must be able to inspect the CI account.');
    assert.equal(response.data.user.name, bobSession.userId);
    return response.data;
  };
  const initial = await details();
  assert.equal(initial.user.deactivated, false);
  assert.equal(initial.deactivation, null);
  assert.ok(initial.sessions.total > 0);
  await bob.goto(origin); await ready(bob);
  const cookie = (await bob.context().cookies(origin)).find(value => value.name === '__Host-tavern-session');
  assert.ok(cookie?.httpOnly && cookie.secure, 'Capture the test session for a later server-side revocation check.');
  await bob.getByRole('button', { name: 'Tavern settings', exact: true }).click();
  await bob.getByRole('tab', { name: 'Account & security', exact: true }).click();
  await bob.getByRole('button', { name: 'Delete my account' }).click();
  const dialog = bob.getByRole('dialog', { name: 'Delete your account?', exact: true });
  const password = dialog.getByLabel('Current password', { exact: true });
  const confirmation = dialog.getByLabel('Type ' + bobSession.userId + ' to confirm', { exact: true });
  const submit = async () => {
    // Every click is a deliberate, distinct probe. Never replay a timed-out or
    // ambiguous deactivation: the durable journal must determine its outcome.
    const [response] = await Promise.all([
      bob.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/account/deactivate'),
      dialog.getByRole('button', { name: 'Permanently deactivate account', exact: true }).click(),
    ]);
    return { status: response.status(), data: await response.json() };
  };
  await password.fill(bobPassword);
  await confirmation.fill('DELETE');
  assert.equal((await submit()).status, 400, 'The exact Matrix user ID is required.');
  await expect(dialog.getByRole('alert')).toContainText('full Matrix user ID');
  await confirmation.fill(bobSession.userId);
  await password.fill('Incorrect CI deactivation password');
  assert.equal((await submit()).status, 403, 'An incorrect password cannot authorize deactivation.');
  const rejected = await details();
  assert.equal(rejected.user.deactivated, false);
  assert.equal(rejected.deactivation, null, 'Rejected confirmation and password checks must not start a deactivation journal.');
  assert.ok(rejected.sessions.total > 0);
  await password.fill(bobPassword);
  await dialog.getByRole('checkbox', { name: 'Request removal of profile information', exact: true }).check();
  const completed = await submit();
  assert.equal(completed.status, 200, 'A healthy native deactivation and local cleanup should complete in the isolated stack.');
  assert.equal(completed.data.ok, true);
  assert.equal(completed.data.deactivation.phase, 'complete');
  const final = await details();
  assert.equal(final.user.deactivated, true, 'A completion response must agree with the authoritative native account state.');
  assert.equal(final.deactivation.id, completed.data.deactivation.id);
  assert.equal(final.deactivation.phase, 'complete');
  assert.equal(final.deactivation.profileErasureRequested, true);
  assert.equal(final.sessions.total, 0);
  await expect(bob.getByLabel('Username or email', { exact: true })).toBeVisible();
  await expect(bob.getByText(completed.data.message, { exact: true })).toBeVisible();
  // Reinstall only this CI account's former cookie. A cleared browser cookie
  // alone would not prove that the server revoked the session itself.
  await bob.context().addCookies([cookie]);
  try {
    const denied = await bob.evaluate(async deviceId => {
      const headers = { 'X-Tavern-Device': deviceId };
      const session = await fetch('/api/auth/session', { headers, cache: 'no-store' });
      const social = await fetch('/api/social', { headers, cache: 'no-store' });
      return { session: session.status, social: social.status };
    }, bobSession.deviceId);
    assert.deepEqual(denied, { session: 401, social: 401 });
  } finally { await bob.context().clearCookies(); }
  const unaffected = await api(alice, '/api/auth/session');
  assert.equal(unaffected.status, 200);
  assert.equal(unaffected.data.userId, aliceSession.userId);
  console.log('PASS: real account settings enforce exact-ID and password confirmation, deactivate Bob in Synapse, finish the durable local journal, preserve the sign-out outcome, revoke the former browser session, and leave Alice signed in.');
}
