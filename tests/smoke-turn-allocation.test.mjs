import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loopbackPort, removeOwnedTurnResource, requireTurnAllocationCi, runTurnDocker, turnContainerArguments, turnFailureSummary } from '../scripts/smoke-turn-allocation.mjs';
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

test('fresh image progress can exhaust the real child output bound, while the fixture requests quiet pull output', async () => {
  const execute = promisify(execFile), calls = [];
  const command = async (binary, args, options) => {
    calls.push({ binary, args, options });
    // Model the external CLI's progress stream with a real bounded child pipe.
    return execute(process.execPath, ['-e', args.includes('--quiet') ? 'process.stdout.write("sha256:fixture\\n")' : 'process.stdout.write("progress\\n".repeat(20000))'], options);
  };
  await assert.rejects(command('docker', ['pull', 'fixture'], { maxBuffer: 65536 }), error => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  assert.equal(await runTurnDocker(['pull', 'fixture'], 120000, command), 'sha256:fixture');
  assert.deepEqual(calls[1].args, ['pull', '--quiet', 'fixture']);
  assert.equal(calls[1].options.maxBuffer, 65536);
  assert.equal(calls[1].options.timeout, 120000);
});

test('command failures retain only safe status fields, never the command, stderr or credentials', async () => {
  const secret = 'PRIVATE-CREDENTIAL-DO-NOT-LOG';
  let failure;
  try { await runTurnDocker(['run', '--static-auth-secret=' + secret], 30000, async () => {
    throw Object.assign(new Error('Command failed: ' + secret), { code: 125, stderr: 'address=PRIVATE-IP ' + secret });
  }); } catch (error) { failure = error; }
  assert.equal(failure.message, 'The isolated TURN container command failed.');
  assert.equal(failure.stderr, undefined);
  assert.equal(turnFailureSummary('container-start', failure), 'stage=container-start reason=command-exit-125');
  assert.equal(turnFailureSummary('image-pull', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'stage=image-pull reason=command-output-limit');
  assert.equal(turnFailureSummary('image-pull', { killed: true }), 'stage=image-pull reason=command-deadline');
});

test('failure diagnostics strictly project stages, browser outcomes and container state without arbitrary text', () => {
  const secret = 'PRIVATE-CREDENTIAL-DO-NOT-LOG';
  const bad = turnFailureSummary(secret, { message: secret, code: secret }, { result: { status: secret, protocol: secret }, captures: secret, closed: secret }, 'exited 1 false\n' + secret);
  assert.equal(bad, 'stage=unknown reason=failed result=invalid protocol=unknown captures=invalid closed=invalid');
  assert.equal(turnFailureSummary('valid-allocation', new Error(secret), { result: { status: 'failed' }, captures: 0, closed: 1 }, 'exited 137 true'),
    'stage=valid-allocation reason=failed result=failed protocol=unknown captures=0 closed=1 container=exited exit=137 oom=true');
  assert.equal(turnFailureSummary('listener', null, undefined, 'running 999 false'), 'stage=listener reason=failed');
});

test('cleanup distinguishes confirmed absence from unknown inspect or inventory failures', async () => {
  const nonce = 'c'.repeat(24), base = 'tavern-turn-ci-' + nonce;
  for (const kind of ['container', 'network']) {
    const name = base + (kind === 'network' ? '-network' : ''), calls = [];
    const inspectFailure = Object.assign(new Error('Unavailable daemon'), { code: 1 });
    const run = async args => { calls.push(args); if (args[1] === 'inspect') throw inspectFailure; return name; };
    await assert.rejects(removeOwnedTurnResource(kind, name, nonce, run), error => error === inspectFailure);
    assert.equal(calls.some(args => args.includes('rm')), false);
    assert.equal(calls[1].includes('name=' + name), true);
    await assert.rejects(removeOwnedTurnResource(kind, name, nonce, async () => { throw inspectFailure; }), error => error === inspectFailure);
    // A successful filtered inventory may contain a different prefixed name.
    // Compare the complete name rather than treating any matching row as ours.
    await removeOwnedTurnResource(kind, name, nonce, async args => { if (args[1] === 'inspect') throw inspectFailure; return name + '-other'; });
  }
});

test('cleanup never removes an unowned resource and removes a confirmed owned fixture only', async () => {
  const nonce = 'd'.repeat(24), name = 'tavern-turn-ci-' + nonce, calls = [];
  await assert.rejects(removeOwnedTurnResource('container', name, nonce, async args => { calls.push(args); return 'other-owner'; }), /unowned/);
  assert.equal(calls.length, 1);
  calls.length = 0;
  await removeOwnedTurnResource('container', name, nonce, async args => { calls.push(args); return nonce; });
  assert.deepEqual(calls[1], ['container', 'rm', '-f', '-v', name]);
  await assert.rejects(removeOwnedTurnResource('container', 'production', nonce, async () => { throw new Error('must not execute'); }), /Invalid isolated TURN ownership/);
});
