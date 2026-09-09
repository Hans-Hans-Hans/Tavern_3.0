import test from 'node:test';
import assert from 'node:assert/strict';
import { loopbackPort, requireTurnAllocationCi, turnContainerArguments } from '../scripts/smoke-turn-allocation.mjs';
test('actual allocation fixture requires explicit disposable Linux CI', () => {
  const env = { GITHUB_ACTIONS: 'true', TAVERN_CI_SMOKE: 'true' };
  requireTurnAllocationCi(env, 'linux');
  for (const changed of [{}, { GITHUB_ACTIONS: 'true' }, { TAVERN_CI_SMOKE: 'true' }, { ...env, GITHUB_ACTIONS: '1' }]) assert.throws(() => requireTurnAllocationCi(changed, 'linux'));
  assert.throws(() => requireTurnAllocationCi(env, 'win32'));
});
test('only a single loopback ephemeral binding is accepted', () => {
  assert.equal(loopbackPort('127.0.0.1:43210\n'), 43210);
  for (const value of ['0.0.0.0:43210', '[::]:43210', '127.0.0.1:80', '127.0.0.1:65536', '127.0.0.1:43210\n0.0.0.0:43210']) assert.throws(() => loopbackPort(value));
});
test('coturn is constrained to its fresh owner, loopback listener and denied peer destinations', () => {
  const nonce = 'a'.repeat(24), name = 'tavern-turn-ci-' + nonce, args = turnContainerArguments(name, name + '-network', nonce, 'b'.repeat(64));
  assert.deepEqual(args.filter((_, i) => args[i - 1] === '-p'), ['127.0.0.1::3478/tcp']);
  assert.equal(args.includes('--read-only'), true); assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  assert.equal(args[args.indexOf('--cap-add') + 1], 'NET_BIND_SERVICE'); assert.equal(args[args.indexOf('--entrypoint') + 1], '/usr/bin/turnserver');
  assert.equal(args.includes('-v'), false); assert.equal(args.includes('--privileged'), false);
  assert.equal(args.includes('--denied-peer-ip=0.0.0.0-255.255.255.255'), true); assert.equal(args.includes('--min-port=49160'), true); assert.equal(args.includes('--max-port=49164'), true);
  assert.throws(() => turnContainerArguments('production', name + '-network', nonce, 'b'.repeat(64)));
  assert.throws(() => turnContainerArguments(name, 'shared-network', nonce, 'b'.repeat(64)));
});
