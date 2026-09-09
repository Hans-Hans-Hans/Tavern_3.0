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
async function docker(args, timeout = 30000) {
  try { return (await execute('docker', args, { timeout, maxBuffer: 65536, windowsHide: true })).stdout.trim(); }
  catch { throw new Error('The isolated TURN container command failed.'); }
}
async function removeOwned(kind, name, nonce) {
  let owner;
  try { owner = await docker([kind, 'inspect', '--format', kind === 'container' ? '{{ index .Config.Labels "' + LABEL + '" }}' : '{{ index .Labels "' + LABEL + '" }}', name]); }
  catch { return; }
  if (owner !== nonce) throw new Error('The TURN fixture will not remove an unowned Docker resource.');
  await docker(kind === 'container' ? ['container', 'rm', '-f', '-v', name] : ['network', 'rm', name]);
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
  let browser, server;
  try {
    await docker(['pull', IMAGE], 120000);
    await docker(['network', 'create', '--internal', '--label', LABEL + '=' + nonce, network]);
    await docker(turnContainerArguments(name, network, nonce, secret));
    const port = loopbackPort(await docker(['port', name, '3478/tcp'])); await waitListening(port);
    const source = await readFile(new URL('../lib/turn-diagnostics.ts', import.meta.url), 'utf8');
    const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Isolated TURN allocation</title>'); }
      else if (request.url === '/runner.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(script); }
      else { response.statusCode = 404; response.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await chromium.launch({ headless: true });
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
    const accepted = await run(password);
    assert.deepEqual(accepted, { result: { status: 'allocated', protocol: 'udp' }, captures: 0, closed: 1 }, 'Valid temporary credentials must allocate a real UDP relay over TURN/TCP.');
    const rejected = await run(randomBytes(24).toString('base64'));
    assert.ok(['failed', 'timeout'].includes(rejected.result.status), 'Invalid credentials must never allocate a relay.');
    assert.equal(rejected.captures, 0); assert.equal(rejected.closed, 1);
    console.log('PASS real Chromium/coturn: relay allocation, invalid-credential rejection and resource cleanup; no media or native-account claim.');
  } finally {
    try { await browser?.close(); }
    finally {
      try { if (server) await new Promise(resolve => server.close(resolve)); }
      finally { try { await removeOwned('container', name, nonce); } finally { await removeOwned('network', network, nonce); } }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  turnAllocationSmoke().catch(() => { console.error('FAIL isolated TURN allocation acceptance. No credentials or candidate addresses are logged.'); process.exitCode = 1; });
}
