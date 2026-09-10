// Real Chromium + coturn allocation and same-server relay bytes. No Matrix
// account, production volume, capture or internet peer destination is involved.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection, isIPv4 } from 'node:net';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import ts from 'typescript';

const execute = promisify(execFile), IMAGE = 'coturn/coturn:4.17.2-r0', LABEL = 'io.tavern.ci.turn-allocation';
const STAGES = new Set(['guard', 'runtime-script', 'image-pull', 'network-create', 'container-start', 'endpoint-proof', 'listener', 'runner-load', 'browser-start', 'valid-allocation', 'invalid-credentials', 'relay-exchange', 'browser-cleanup', 'server-cleanup', 'container-cleanup', 'network-cleanup']);
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
function privateIPv4(value) {
  if (!isIPv4(value)) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
}
function inSubnet(address, subnet, prefix) {
  if (typeof subnet !== 'string') return false;
  const [network, bits, extra] = subnet.split('/');
  if (extra !== undefined || !isIPv4(network) || !/^[0-9]{1,2}$/.test(bits) || Number(bits) !== prefix || prefix < 8 || prefix > 30) return false;
  const integer = value => value.split('.').reduce((number, octet) => (number * 256 + Number(octet)) >>> 0, 0), mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((integer(address) & mask) >>> 0) === ((integer(network) & mask) >>> 0);
}
export function isolatedTurnEndpoint(network, container, { nonce, name, networkName, networkId, containerId }) {
  const invalid = () => { throw new Error('The isolated TURN endpoint ownership could not be confirmed.'); };
  if (!/^[a-f0-9]{24}$/.test(nonce) || name !== 'tavern-turn-ci-' + nonce || networkName !== name + '-network' ||
      !/^[a-f0-9]{64}$/.test(networkId) || !/^[a-f0-9]{64}$/.test(containerId)) return invalid();
  if (network?.Id !== networkId || network.Name !== networkName || network.Driver !== 'bridge' || network.Scope !== 'local' || network.Internal !== true ||
      network.EnableIPv6 !== false || network.Labels?.[LABEL] !== nonce || ![undefined, 'nat'].includes(network.Options?.['com.docker.network.bridge.gateway_mode_ipv4']) ||
      !network.Containers || Object.keys(network.Containers).length !== 1 || network.Containers[containerId]?.Name !== name) return invalid();
  if (container?.Id !== containerId || container.Name !== '/' + name || container.Running !== true || container.Owner !== nonce ||
      !container.Networks || Object.keys(container.Networks).length !== 1 || !container.Networks[networkName] ||
      container.PortBindings !== null && (!container.PortBindings || typeof container.PortBindings !== 'object' || Array.isArray(container.PortBindings) || Object.keys(container.PortBindings).length)) return invalid();
  const endpoint = container.Networks[networkName], member = network.Containers[containerId], address = endpoint.IPAddress;
  if (endpoint.NetworkID !== networkId || !privateIPv4(address) || !Number.isInteger(endpoint.IPPrefixLen) || endpoint.GlobalIPv6Address || member.IPv6Address ||
      member.IPv4Address !== address + '/' + endpoint.IPPrefixLen || !Array.isArray(network.IPAM?.Config) || network.IPAM.Config.length !== 1 ||
      !inSubnet(address, network.IPAM.Config[0].Subnet, endpoint.IPPrefixLen)) return invalid();
  return { address, port: 3478 };
}
export function coturnRuntimeScript(compose) {
  // This deliberately accepts only the canonical Compose block format. Never
  // invent a fallback implementation that could stop testing production code.
  if (typeof compose !== 'string' || compose.length > 128000) throw new Error('Coturn runtime is unavailable.');
  const block = compose.replaceAll('\r\n', '\n').match(/^  coturn:\n([\s\S]*?)^  livekit:/m)?.[1];
  const body = block?.match(/^    entrypoint: \["\/bin\/sh", "-ec"\]\n    command:\n      - \|\n((?:        .*\n)+)      - tavern-coturn\n      - -c\n      - \/config\/turnserver\.conf\n/m)?.[1];
  if (!body) throw new Error('Coturn runtime is unavailable.');
  return body.replace(/^        /gm, '').replaceAll('$$', '$');
}
export function turnContainerArguments(name, network, nonce, secret, runtime) {
  if (!/^[a-f0-9]{24}$/.test(nonce) || name !== 'tavern-turn-ci-' + nonce || network !== name + '-network' || !/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid isolated TURN ownership.');
  if (typeof runtime !== 'string' || runtime.length > 8192 || !runtime.includes('exec /usr/bin/turnserver "$@" "--allowed-peer-ip=$turn_self_ip"')) throw new Error('The production coturn runtime is required.');
  return ['run', '-d', '--name', name, '--label', LABEL + '=' + nonce, '--network', network, '--user', '0:0',
    '--read-only', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '128', '--memory', '128m', '--cpus', '1', '--log-driver', 'none',
    '--tmpfs', '/tmp:size=8m,mode=1777', '--tmpfs', '/var/lib/coturn:size=1m,mode=1777',
    '--entrypoint', '/bin/sh', IMAGE, '-ec', runtime, 'tavern-coturn',
    '-n', '--listening-ip=0.0.0.0', '--listening-port=3478', '--relay-threads=1', '--min-port=49160', '--max-port=49164',
    '--realm=tavern-turn-ci.invalid', '--use-auth-secret', '--static-auth-secret=' + secret, '--fingerprint',
    '--max-allocate-lifetime=60', '--user-quota=4', '--total-quota=8', '--no-cli', '--no-tls', '--no-dtls', '--no-tcp-relay', '--no-multicast-peers',
    '--denied-peer-ip=0.0.0.0-255.255.255.255', '--denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    // A documentation-only external address exercises coturn's public→private
    // mapping without requiring NAT or any public route. The production entry
    // point adds only this container's exact private IP to the peer whitelist.
    '--external-ip=198.51.100.1', '--allowed-peer-ip=198.51.100.1',
    '--pidfile=/tmp/turn.pid', '--no-stdout-log', '--log-file=/dev/null', '--simple-log'];
}

export async function exchangeRelayData({ address, port, username, credential, nonce }) {
  const peers = [], channels = [], cleanup = [];
  let timer, captures = 0, result;
  const failure = () => new Error('The isolated relay byte exchange failed.');
  const originalUser = navigator.mediaDevices.getUserMedia, originalDisplay = navigator.mediaDevices.getDisplayMedia;
  navigator.mediaDevices.getUserMedia = navigator.mediaDevices.getDisplayMedia = async () => { captures++; throw failure(); };
  const expect = value => { if (!value) throw failure(); };
  const listen = (target, type, fn) => { target.addEventListener(type, fn); cleanup.push(() => target.removeEventListener(type, fn)); };
  const until = (target, type, ready) => new Promise((resolve, reject) => {
    const check = () => { try { if (ready()) resolve(); } catch { reject(failure()); } }; listen(target, type, check); check();
  });
  const gather = async (peer, description) => {
    await peer.setLocalDescription(description);
    await until(peer, 'icegatheringstatechange', () => peer.iceGatheringState === 'complete');
    const candidates = peer.localDescription.sdp.split(/\r?\n/).filter(line => line.startsWith('a=candidate:'));
    expect(candidates.length > 0 && candidates.length <= 8);
    for (const line of candidates) {
      const candidate = new RTCIceCandidate({ candidate: line.slice(2), sdpMid: '0' });
      expect(candidate.type === 'relay' && candidate.protocol === 'udp' && candidate.address === '198.51.100.1' && candidate.port >= 49160 && candidate.port <= 49164);
    }
    return { type: peer.localDescription.type, sdp: peer.localDescription.sdp };
  };
  try {
    result = await Promise.race([(async () => {
      for (let index = 0; index < 2; index++) {
        const peer = new RTCPeerConnection({ iceTransportPolicy: 'relay', iceServers: [{ urls: ['turn:' + address + ':' + port + '?transport=tcp'], username, credential }] });
        peers.push(peer); channels.push(peer.createDataChannel('isolated-relay-proof', { negotiated: true, id: 0 }));
      }
      const receipts = channels.map((channel, index) => new Promise((resolve, reject) => listen(channel, 'message', event => event.data === nonce + ':' + (1 - index) ? resolve() : reject(failure()))));
      // Attach rejection handling immediately, even before SDP negotiation.
      const delivered = Promise.all(receipts); delivered.catch(() => {});
      const offer = await gather(peers[0], await peers[0].createOffer());
      await peers[1].setRemoteDescription(offer);
      const answer = await gather(peers[1], await peers[1].createAnswer());
      await peers[0].setRemoteDescription(answer);
      await Promise.all(channels.map(channel => until(channel, 'open', () => { expect(channel.readyState !== 'closed'); return channel.readyState === 'open'; })));
      channels.forEach((channel, index) => channel.send(nonce + ':' + index));
      await delivered;
      for (const peer of peers) {
        const stats = await peer.getStats();
        const transport = [...stats.values()].find(value => value.type === 'transport' && value.selectedCandidatePairId);
        const pair = transport && stats.get(transport.selectedCandidatePairId);
        expect(pair?.state === 'succeeded' && stats.get(pair.localCandidateId)?.candidateType === 'relay' && stats.get(pair.remoteCandidateId)?.candidateType === 'relay');
      }
      return { exchanged: true, relayPairs: 2 };
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(failure()), 25000); })]);
  } finally {
    clearTimeout(timer); cleanup.forEach(remove => remove()); channels.forEach(channel => channel.close()); peers.forEach(peer => peer.close());
    navigator.mediaDevices.getUserMedia = originalUser; navigator.mediaDevices.getDisplayMedia = originalDisplay;
  }
  return { ...result, captures, closed: peers.filter(peer => peer.signalingState === 'closed').length };
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
async function waitListening(address, port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await new Promise(resolve => { const socket = createConnection({ host: address, port }); socket.setTimeout(250);
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
    stage = 'runtime-script';
    const runtime = coturnRuntimeScript(await readFile(new URL('../compose.yaml', import.meta.url), 'utf8'));
    stage = 'image-pull';
    await docker(['pull', IMAGE], 120000);
    stage = 'network-create';
    const networkId = await docker(['network', 'create', '--driver', 'bridge', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=nat', '--label', LABEL + '=' + nonce, network]);
    stage = 'container-start';
    const containerId = await docker(turnContainerArguments(name, network, nonce, secret, runtime));
    // Internal Docker networks deliberately skip published-port programming.
    // The Linux host can reach their bridge addresses directly. Inspect only
    // this fresh private endpoint; never read or expose the secret-bearing CMD.
    stage = 'endpoint-proof';
    const networkState = JSON.parse(await docker(['network', 'inspect', '--format', '{{json .}}', network]));
    const containerState = JSON.parse(await docker(['container', 'inspect', '--format', '{"Id":{{json .Id}},"Name":{{json .Name}},"Running":{{json .State.Running}},"Owner":{{json (index .Config.Labels "' + LABEL + '")}},"Networks":{{json .NetworkSettings.Networks}},"PortBindings":{{json .HostConfig.PortBindings}}}', name]));
    const { address, port } = isolatedTurnEndpoint(networkState, containerState, { nonce, name, networkName: network, networkId, containerId });
    stage = 'listener'; await waitListening(address, port);
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
    const run = credential => page.evaluate(async ({ address, port, username, credential }) => {
      const { runTurnDiagnostic } = await import('/runner.js');
      let captures = 0, closed = 0;
      navigator.mediaDevices.getUserMedia = async () => { captures++; throw new Error('Capture is forbidden'); };
      navigator.mediaDevices.getDisplayMedia = async () => { captures++; throw new Error('Capture is forbidden'); };
      const result = await runTurnDiagnostic({ current: () => true, signal: new AbortController().signal,
        prepare: async () => [{ urls: ['turn:' + address + ':' + port + '?transport=tcp'], username, credential }],
        createPeer: configuration => { const peer = new RTCPeerConnection(configuration), close = peer.close.bind(peer); peer.close = () => { closed++; close(); }; return peer; } });
      return { result, captures, closed };
    }, { address, port, username, credential });
    stage = 'valid-allocation'; const accepted = observation = await run(password);
    assert.deepEqual(accepted, { result: { status: 'allocated', protocol: 'udp' }, captures: 0, closed: 1 }, 'Valid temporary credentials must allocate a real UDP relay over TURN/TCP.');
    stage = 'invalid-credentials'; observation = undefined;
    const rejected = observation = await run(randomBytes(24).toString('base64'));
    assert.ok(['failed', 'timeout'].includes(rejected.result.status), 'Invalid credentials must never allocate a relay.');
    assert.equal(rejected.captures, 0); assert.equal(rejected.closed, 1);
    stage = 'relay-exchange'; observation = undefined;
    const exchanged = await page.evaluate(exchangeRelayData, { address, port, username, credential: password, nonce });
    assert.deepEqual(exchanged, { exchanged: true, relayPairs: 2, captures: 0, closed: 2 }, 'Two same-server relay-only peers must exchange real bytes through the production exact-self ACL.');
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
  console.log('PASS real Chromium/coturn: relay allocation, invalid-credential rejection, same-server relay-only byte exchange and resource cleanup; no media or native-account claim.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  turnAllocationSmoke().catch(error => { console.error('FAIL isolated TURN allocation acceptance: ' + (error instanceof TurnFixtureFailure ? error.message : turnFailureSummary('guard', error)) + '. No credentials or candidate addresses are logged.'); process.exitCode = 1; });
}
