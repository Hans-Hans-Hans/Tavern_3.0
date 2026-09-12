import test from 'node:test';
import assert from 'node:assert/strict';
import { roomRemovalSmoke } from '../scripts/smoke-room-removal.mjs';
test('native deletion acceptance refuses unscoped invocation before any reads or mutations', async () => {
  let touched = false;
  await assert.rejects(roomRemovalSmoke({ origin: 'https://outside.invalid', api: async () => { touched = true; } }), /exact isolated CI/);
  assert.equal(touched, false);
});
