import test from 'node:test';
import assert from 'node:assert/strict';
import { channelAdmissionSmoke } from '../scripts/smoke-channel-admission.mjs';

test('native admission acceptance refuses unscoped invocation before any browser or API access', async () => {
  let touched = false;
  await assert.rejects(channelAdmissionSmoke({ origin: 'https://outside.invalid', api: async () => { touched = true; } }), /exact isolated CI/);
  assert.equal(touched, false);
});
