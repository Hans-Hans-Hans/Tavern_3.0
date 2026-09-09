import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { checkedTurnServers, runTurnDiagnostic, TurnDiagnosticUnavailable } = loadTs('../lib/turn-diagnostics.ts', {});
const servers = [{ urls: ['turn:turn.example.test:3478?transport=udp'], username: 'short-lived', credential: 'secret-fixture' }];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(extra = {}) {
  const f = { current: true, closed: 0, channelClosed: 0, peers: [], deadlines: new Map(), intervals: new Map(), seq: 0 };
  const peer = { iceGatheringState: 'gathering', iceConnectionState: 'new', onicecandidate: null, onicegatheringstatechange: null, oniceconnectionstatechange: null,
    createDataChannel(name, options) { f.channel = { name, options }; return { close() { f.channelClosed++; } }; },
    async createOffer() { return { type: 'offer', sdp: 'fixture' }; }, async setLocalDescription(offer) { f.offer = offer; }, close() { f.closed++; } };
  const controller = new AbortController();
  f.controller = controller; f.peer = peer;
  f.options = { current: () => f.current, signal: controller.signal, prepare: async signal => { f.preparationSignal = signal; return servers; },
    createPeer(config) { f.peers.push(config); return peer; }, clock: {
      setTimeout(fn, ms) { const id = ++f.seq; f.deadlines.set(id, { fn, ms }); return id; }, clearTimeout(id) { f.deadlines.delete(id); },
      setInterval(fn, ms) { const id = ++f.seq; f.intervals.set(id, { fn, ms }); return id; }, clearInterval(id) { f.intervals.delete(id); },
    }, ...extra };
  f.run = () => runTurnDiagnostic(f.options); return f;
}
test('strict native TURN configuration excludes STUN, URL credentials, malformed ports and unbounded lists', () => {
  assert.deepEqual(checkedTurnServers(servers), servers);
  assert.deepEqual(checkedTurnServers([{ ...servers[0], urls: ['turns:[2001:db8::1]:5349?transport=tcp'] }])[0].urls, ['turns:[2001:db8::1]:5349?transport=tcp']);
  for (const url of ['stun:outside.example', 'https://outside.example', 'turn:user:pass@host', 'turn:host:65536', 'turn:host:0', 'turn:host#secret', 'turn:host?transport=udp&other=x', 'turn:[invalid]'])
    assert.throws(() => checkedTurnServers([{ ...servers[0], urls: [url] }]), TurnDiagnosticUnavailable);
  assert.throws(() => checkedTurnServers(Array.from({ length: 5 }, () => servers[0])));
  assert.throws(() => checkedTurnServers([{ ...servers[0], urls: Array(9).fill('turn:host') }]));
  assert.throws(() => checkedTurnServers([]), error => error.status === 'not-configured');
});
test('only a relay candidate succeeds, reports no addresses and releases every resource', async () => {
  const f = fixture(), result = f.run(); await flush();
  assert.equal(f.peers[0].iceTransportPolicy, 'relay'); assert.equal(f.peers[0].iceCandidatePoolSize, 0);
  assert.deepEqual(f.channel.options, { negotiated: true, id: 0 });
  f.peer.onicecandidate({ candidate: { type: 'host', protocol: 'udp', address: 'private-address' } }); assert.equal(f.closed, 0);
  f.peer.onicecandidate({ candidate: { type: 'srflx', protocol: 'udp' } }); assert.equal(f.closed, 0);
  f.peer.onicecandidate({ candidate: { type: 'relay', protocol: 'udp', candidate: 'never returned', address: '192.0.2.1' } });
  assert.deepEqual(await result, { status: 'allocated', protocol: 'udp' });
  assert.equal(f.closed, 1); assert.equal(f.channelClosed, 1); assert.equal(f.peer.onicecandidate, null);
  assert.equal(f.deadlines.size + f.intervals.size, 0); assert.equal(f.preparationSignal.aborted, true);
});
test('deadline covers credential wait and suppresses a late successful refresh', async () => {
  let release; const f = fixture({ prepare: () => new Promise(resolve => { release = resolve; }) }), result = f.run();
  [...f.deadlines.values()][0].fn(); assert.deepEqual(await result, { status: 'timeout' });
  release(servers); await flush(); assert.equal(f.peers.length, 0); assert.equal(f.intervals.size, 0);
});
test('cancellation while an offer waits prevents setLocalDescription and closes the data channel', async () => {
  const f = fixture(); let release; f.peer.createOffer = () => new Promise(resolve => { release = resolve; });
  const result = f.run(); await flush(); f.controller.abort();
  assert.deepEqual(await result, { status: 'cancelled' }); release({ type: 'offer' }); await flush();
  assert.equal(f.offer, undefined); assert.equal(f.closed, 1); assert.equal(f.channelClosed, 1);
});
test('fresh admin verification stays within the original deadline and cannot publish after owner drift', async () => {
  let release; const f = fixture({ verify: () => new Promise(resolve => { release = resolve; }) }), result = f.run(); await flush();
  f.peer.onicecandidate({ candidate: { type: 'relay', protocol: 'tcp' } }); await flush();
  f.peer.onicegatheringstatechange(); f.current = false; [...f.intervals.values()][0].fn();
  assert.deepEqual(await result, { status: 'cancelled' }); release(); await flush(); assert.equal(f.closed, 1);
});
test('final native admin denial and raw network errors yield only fixed non-sensitive statuses', async () => {
  const denied = fixture({ verify: async () => { throw new TurnDiagnosticUnavailable('unauthorized'); } });
  const first = denied.run(); await flush(); denied.peer.onicecandidate({ candidate: { type: 'relay' } });
  assert.deepEqual(await first, { status: 'unauthorized' });
  const failed = fixture({ prepare: async () => { throw new Error('credential=SECRET turn:private.invalid 10.0.0.1'); } });
  assert.deepEqual(await failed.run(), { status: 'failed' }); assert.equal(failed.peers.length, 0);
});
test('complete gathering without a relay fails and pre-aborted attempts never fetch credentials', async () => {
  const f = fixture(), result = f.run(); await flush(); f.peer.onicecandidate({ candidate: null });
  assert.deepEqual(await result, { status: 'failed' }); assert.equal(f.closed, 1);
  const cancelled = fixture(); cancelled.controller.abort(); assert.deepEqual(await cancelled.run(), { status: 'cancelled' }); assert.equal(cancelled.preparationSignal, undefined);
});
