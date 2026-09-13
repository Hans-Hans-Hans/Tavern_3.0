import test from 'node:test';
import assert from 'node:assert/strict';
import { roleManagementSmoke } from '../scripts/smoke-role-management.mjs';
test('role UI acceptance rejects production or unowned fixture inputs before network or UI activity', async () => {
  const previous = { TAVERN_CI_SMOKE: process.env.TAVERN_CI_SMOKE, TAVERN_CI_TLS: process.env.TAVERN_CI_TLS };
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/tavern-ci-tls';
  const runId = 'a'.repeat(24), base = { origin: 'https://chat.example.test', serverId: '!fixture:chat.example.test', runId, serverName: 'CI member moderation server ' + runId,
    adminSession: { userId: '@ciadmin:chat.example.test', deviceId: 'ADMIN', admin: true }, aliceSession: { userId: '@cialice:chat.example.test', deviceId: 'ALICE', admin: false }, api: async () => assert.fail('No requests') };
  try {
    for (const override of [{ origin: 'https://production.example' }, { serverId: '!elsewhere:production.example' }, { runId: 'wrong' }, { serverName: 'Existing server' },
      { adminSession: { ...base.adminSession, admin: false } }, { aliceSession: { ...base.aliceSession, deviceId: '' } }, { api: undefined }]) {
      await assert.rejects(roleManagementSmoke({ ...base, ...override }), /exact isolated CI/);
    }
    process.env.TAVERN_CI_SMOKE = 'false'; await assert.rejects(roleManagementSmoke(base), /exact isolated CI/);
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
