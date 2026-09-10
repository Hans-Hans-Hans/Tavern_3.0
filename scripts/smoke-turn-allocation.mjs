// Real Chromium + coturn allocation only. No Matrix account, production volume,
// remote peer, microphone, camera or internet relay destination is involved.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import ts from 'typescript';

const execute = promisify(execFile), IMAGE = 'coturn/coturn:4.17.2-r0', LABEL = 'io.tavern.ci.turn-allocation';
const STAGES = new Set(['guard', 'image-pull', 'network-create', 'container-start', 'port-binding', 'listener', 'runner-load', 'browser-start', 'valid-allocation', 'invalid-credentials', 'browser-cleanup', 'server-cleanup', 'container-cleanup', 'network-cleanup']);
const RESULTS = new Set(['allocated', 'failed', 'timeout', 'cancelled', 'unavailable', 'not-configured', 'unauthorized']);
class TurnFixtureFailure extends Error {}
export function turnFailureSummary(stage, error, observation, container) {
  const reason = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'command-output-limit' : error?.killed === true ? 'command-deadline' :
    Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255 ? 'command-exit-' + error.code : 'failed';
  const output = ['stage=' + (STAGES.has(stage) ? stage : 'unknown'), 'reason=' + reason];
  if (observation) {
    output.push('result=' + (RESULTS.has(observation.result?.status) ? observation.result.status : 'invalid'));
    output.push('protocol=' + (['udp', 'tcp'].includes(observation.result?.protocol) ? observation.result.protocol : 'unknown'));
    for (const key of ['captures', 'closed']) output.push(key + '=' + (Number.isInteger(observation[key]) && observation[key] >= 0 && observation[key] <= 8 ? observation[key] : 'invalid'));
  }
  if (typeof container === 'string' && /^(created|running|paused|restarting|removing|exited|dead) [0-9]{1,3} (true|false)$/.test(container)) {
    const [state, exit, oom] = container.split(' ');
    if (Number(exit) <= 255) output.push('container=' + state, 'exit=' + exit, 'oom=' + oom);
  }
  return output.join(' ');
}
export function requireTurnAllocationCi(environment = process.env, platform = process.platform) {
  if (platform !== 'linux' || environment.GITHUB_ACTIONS !== 'true' || environment.TAVERN_CI_SMOKE !== 'true')
    throw new Error('TURN allocation acceptance requires the disposable Linux GitHub Actions runner.');
}
export function loopbackPort(value) {
  const match = /^127\.0\.0\.1:([0-9]{1,5})\s*$/.exec(value);
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw new Error('The isolated TURN port must be published only on loopback.');
  return Number(match[1]);
}
export function turnContainerArguments(name, network, nonce, secret) {
  if (!/^[a-f0-9]{24}$/.test(nonce) || name !== 'tavern-turn-ci-' + nonce || network !== name + '-network' || !/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid isolated TURN ownership.');
  return ['run', '-d', '--name', name, '--label', LABEL + '=' + nonce, '--network', network, '--user', '0:0',
    '--read-only', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '128', '--memory', '128m', '--cpus', '1', '--log-driver', 'none',
    '--tmpfs', '/tmp:size=8m,mode=1777', '--tmpfs', '/var/lib/coturn:size=1m,mode=1777',
    '-p', '127.0.0.1::3478/tcp', '--entrypoint', '/usr/bin/turnserver', IMAGE,
    '-n', '--listening-ip=0.0.0.0', '--listening-port=3478', '--relay-threads=1', '--min-port=49160', '--max-port=49164',
    '--realm=tavern-turn-ci.invalid', '--use-auth-secret', '--static-auth-secret=' + secret, '--fingerprint',
    '--max-allocate-lifetime=60', '--user-quota=4', '--total-quota=8', '--no-cli', '--no-tls', '--no-dtls', '--no-tcp-relay', '--no-multicast-peers',
    '--denied-peer-ip=0.0.0.0-255.255.255.255', '--denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '--pidfile=/tmp/turn.pid', '--no-stdout-log', '--log-file=/dev/null', '--simple-log'];
}
export async function runTurnDocker(args, timeout = 30000, executeCommand = execute) {
  // A fresh image pull can otherwise fill execFile's bounded output buffer with
  // progress updates before the container is created. Keep the buffer bound.
  const command = args[0] === 'pull' ? ['pull', '--quiet', ...args.slice(1)] : args;
  try { return (await executeCommand('docker', command, { timeout, maxBuffer: 65536, windowsHide: true })).stdout.trim(); }
  catch (error) {
    const failure = new Error('The isolated TURN container command failed.');
    failure.code = error?.code; failure.killed = error?.killed === true;
    throw failure;
  }
}
const docker = runTurnDocker;
export async function removeOwnedTurnResource(kind, name, nonce, command = docker) {
  if (!['container', 'network'].includes(kind) || !/^[a-f0-9]{24}$/.test(nonce) || name !== 'tavern-turn-ci-' + nonce + (kind === 'network' ? '-network' : '')) throw new Error('Invalid isolated TURN ownership.');
  let owner;
  try { owner = await command([kind, 'inspect', '--format', kind === 'container' ? '{{ index .Config.Labels "' + LABEL + '" }}' : '{{ index .Labels "' + LABEL + '" }}', name]); }
  catch (error) {
    // Failed inspect does not prove absence: a disconnected daemon or permission
    // failure must never turn skipped cleanup into a successful acceptance.
    const names = await command([kind, 'ls', ...(kind === 'container' ? ['--all'] : []), '--filter', 'name=' + name, '--format', kind === 'container' ? '{{.Names}}' : '{{.Name}}']);
    if (names.split(/\r?\n/).includes(name)) throw error;
    return;
  }
  if (owner !== nonce) throw new Error('The TURN fixture will not remove an unowned Docker resource.');
  await command(kind === 'container' ? ['container', 'rm', '-f', '-v', name] : ['network', 'rm', name]);
}
async function waitListening(port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await new Promise(resolve => { const socket = createConnection({ host: '127.0.0.1', port }); socket.setTimeout(250);
      const done = value => { socket.destroy(); resolve(value); }; socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('timeout', () => done(false)); })) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The isolated TURN listener did not become ready.');
}

export async function turnAllocationSmoke() {
  requireTurnAllocationCi();
  const nonce = randomBytes(12).toString('hex'), name = 'tavern-turn-ci-' + nonce, network = name + '-network', secret = randomBytes(32).toString('hex');
  let browser, server, stage = 'image-pull', observation;
  const failures = [];
  try {
    await docker(['pull', IMAGE], 120000);
    stage = 'network-create';
    await docker(['network', 'create', '--internal', '--label', LABEL + '=' + nonce, network]);
    stage = 'container-start';
    await docker(turnContainerArguments(name, network, nonce, secret));
    stage = 'port-binding';
    const port = loopbackPort(await docker(['port', name, '3478/tcp']));
    stage = 'listener'; await waitListening(port);
    stage = 'runner-load';
    const source = await readFile(new URL('../lib/turn-diagnostics.ts', import.meta.url), 'utf8');
    const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Isolated TURN allocation</title>'); }
      else if (request.url === '/runner.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(script); }
      else { response.statusCode = 404; response.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    stage = 'browser-start'; browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); await page.goto('http://127.0.0.1:' + server.address().port);
    const username = Math.floor(Date.now() / 1000 + 90) + ':' + nonce, password = createHmac('sha1', secret).update(username).digest('base64');
    const run = credential => page.evaluate(async ({ port, username, credential }) => {
      const { runTurnDiagnostic } = await import('/runner.js');
      let captures = 0, closed = 0;
      navigator.mediaDevices.getUserMedia = async () => { captures++; throw new Error('Capture is forbidden'); };
      navigator.mediaDevices.getDisplayMedia = async () => { captures++; throw new Error('Capture is forbidden'); };
      const result = await runTurnDiagnostic({ current: () => true, signal: new AbortController().signal,
        prepare: async () => [{ urls: ['turn:127.0.0.1:' + port + '?transport=tcp'], username, credential }],
        createPeer: configuration => { const peer = new RTCPeerConnection(configuration), close = peer.close.bind(peer); peer.close = () => { closed++; close(); }; return peer; } });
      return { result, captures, closed };
    }, { port, username, credential });
    stage = 'valid-allocation'; const accepted = observation = await run(password);
    assert.deepEqual(accepted, { result: { status: 'allocated', protocol: 'udp' }, captures: 0, closed: 1 }, 'Valid temporary credentials must allocate a real UDP relay over TURN/TCP.');
    stage = 'invalid-credentials'; observation = undefined;
    const rejected = observation = await run(randomBytes(24).toString('base64'));
    assert.ok(['failed', 'timeout'].includes(rejected.result.status), 'Invalid credentials must never allocate a relay.');
    assert.equal(rejected.captures, 0); assert.equal(rejected.closed, 1);
  } catch (error) {
    let container;
    try { container = await docker(['container', 'inspect', '--format', '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}', name]); } catch { /* No owned container may have been created. */ }
    failures.push(turnFailureSummary(stage, error, observation, container));
  } finally {
    for (const [cleanup, action] of [
      ['browser-cleanup', () => browser?.close()],
      ['server-cleanup', () => server && new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))],
      ['container-cleanup', () => removeOwnedTurnResource('container', name, nonce)],
      ['network-cleanup', () => removeOwnedTurnResource('network', network, nonce)],
    ]) {
      try { await action(); } catch (error) { failures.push(turnFailureSummary(cleanup, error)); }
    }
  }
  if (failures.length) throw new TurnFixtureFailure(failures.join('; '));
  console.log('PASS real Chromium/coturn: relay allocation, invalid-credential rejection and resource cleanup; no media or native-account claim.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  turnAllocationSmoke().catch(error => { console.error('FAIL isolated TURN allocation acceptance: ' + (error instanceof TurnFixtureFailure ? error.message : turnFailureSummary('guard', error)) + '. No credentials or candidate addresses are logged.'); process.exitCode = 1; });
}
