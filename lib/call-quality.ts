import type { MatrixCall } from 'matrix-js-sdk';

type Counter = { timestamp: number; bytes?: number; received?: number; lost?: number };
export type QualityBaseline = Map<string, Counter>;
export type CallQuality = { connection: string; ice: string; gathering: string; iceErrors?: number[]; localCandidates: number | null; localRelayCandidates: number | null; remoteCandidates: number | null; localRoute: string | null; roundTripMs: number | null; jitterMs: number | null; downloadKbps: number | null; uploadKbps: number | null; receiveLossPercent: number | null; sampledAt: number; available: boolean; error: string };
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => numeric(value) && value >= 0;
const rounded = (value: number) => Math.round(value * 10) / 10;

export function projectCallQuality(raw: unknown, previous: QualityBaseline = new Map(), connection = 'unavailable', ice = 'unavailable', gathering = 'unavailable') {
  const rows = Array.isArray(raw) ? raw.filter((row): row is Record<string, any> => !!row && typeof row === 'object').slice(0, 2000) : [];
  const counters: QualityBaseline = new Map();
  let upload = 0, download = 0, uploadSamples = 0, downloadSamples = 0, received = 0, lost = 0, lossSamples = 0, jitter: number | null = null;
  for (const row of rows) {
    if (!['inbound-rtp', 'outbound-rtp'].includes(row.type) || row.isRemote || typeof row.id !== 'string' || !numeric(row.timestamp)) continue;
    const incoming = row.type === 'inbound-rtp', bytes = incoming ? row.bytesReceived : row.bytesSent;
    const counter: Counter = { timestamp: row.timestamp, ...(nonnegative(bytes) ? { bytes } : {}),
      ...(incoming && nonnegative(row.packetsReceived) ? { received: row.packetsReceived } : {}), ...(incoming && numeric(row.packetsLost) ? { lost: row.packetsLost } : {}) };
    counters.set(row.id, counter);
    if (incoming && nonnegative(row.jitter)) jitter = Math.max(jitter ?? 0, row.jitter * 1000);
    const before = previous.get(row.id), elapsed = before ? row.timestamp - before.timestamp : 0;
    if (!before || elapsed <= 0 || elapsed > 10000) continue;
    if (counter.bytes !== undefined && before.bytes !== undefined && counter.bytes >= before.bytes) {
      const kbps = (counter.bytes - before.bytes) * 8 / elapsed;
      if (incoming) { download += kbps; downloadSamples++; } else { upload += kbps; uploadSamples++; }
    }
    if (incoming && counter.received !== undefined && before.received !== undefined && counter.lost !== undefined && before.lost !== undefined && counter.received >= before.received && counter.lost >= before.lost) {
      received += counter.received - before.received; lost += counter.lost - before.lost; lossSamples++;
    }
  }
  const ids = new Map(rows.filter(row => typeof row.id === 'string').map(row => [row.id, row]));
  const selectedIds = new Set(rows.filter(row => row.type === 'transport' && typeof row.selectedCandidatePairId === 'string').map(row => row.selectedCandidatePairId));
  const selected = rows.filter(row => row.type === 'candidate-pair' && (selectedIds.has(row.id) || !selectedIds.size && row.selected === true));
  const fallback = rows.filter(row => row.type === 'candidate-pair' && row.nominated === true && row.state === 'succeeded');
  const pair = selected.length === 1 ? selected[0] : !selected.length && fallback.length === 1 ? fallback[0] : undefined;
  const local = pair && ids.get(pair.localCandidateId);
  const candidateCount = (type: string, relay = false) => Array.isArray(raw) && raw.length <= 2000
    ? [...ids.values()].filter(row => row.type === type && (!relay || row.candidateType === 'relay')).length : null;
  const result: CallQuality = { connection, ice, gathering, localCandidates: candidateCount('local-candidate'), localRelayCandidates: candidateCount('local-candidate', true), remoteCandidates: candidateCount('remote-candidate'), localRoute: ['relay', 'srflx', 'prflx', 'host'].includes(local?.candidateType) ? local!.candidateType : null,
    roundTripMs: pair && nonnegative(pair.currentRoundTripTime) ? rounded(pair.currentRoundTripTime * 1000) : null,
    jitterMs: jitter === null ? null : rounded(jitter), downloadKbps: downloadSamples ? rounded(download) : null, uploadKbps: uploadSamples ? rounded(upload) : null,
    receiveLossPercent: lossSamples && received + lost > 0 ? rounded(lost * 100 / (received + lost)) : null, sampledAt: Date.now(), available: rows.length > 0, error: '' };
  // Only counters and explicitly selected metrics survive this projection. ICE
  // addresses, ports, certificates and complete reports are never retained.
  return { quality: result, counters };
}

export function callConnectionPresentation(quality: CallQuality | null) {
  if (quality?.gathering === 'complete' && quality.localRelayCandidates === 0 && ['new', 'connecting'].includes(quality.connection)) return { label: 'Relay unavailable', guidance: 'The browser finished gathering without a TURN relay candidate. End this call and try again. Your administrator can use Test TURN allocation and the ICE error codes in Connection details to check relay availability.' };
  if (quality?.connection === 'failed' || quality?.ice === 'failed') return { label: 'Connection failed', guidance: 'The media connection failed. End this call and try again. Ask your administrator to run Test TURN allocation and check the TURN relay ports. A successful allocation alone does not confirm that media can reach the other participant.' };
  if (quality?.connection === 'disconnected' || quality?.ice === 'disconnected') return { label: 'Media disconnected', guidance: 'The media connection was interrupted. If it does not recover, end this call and try again. Connection details show TURN candidate counts without exposing addresses.' };
  if (quality?.connection === 'closed' || quality?.ice === 'closed') return { label: 'Media connection closed', guidance: '' };
  if (quality?.connection === 'connected' && ['connected', 'completed'].includes(quality.ice)) return { label: quality.localRoute === 'relay' ? 'Connected · Relayed encrypted media' : 'Connected · Relay route not confirmed', guidance: '' };
  return { label: 'Connecting media…', guidance: '' };
}

export function watchCallQuality(call: Pick<MatrixCall, 'getCurrentCallStats' | 'peerConn'>, update: (value: CallQuality) => void, interval = 2000) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, previous: QualityBaseline = new Map();
  let watchedPeer: RTCPeerConnection | undefined, last: CallQuality | undefined;
  let iceErrors: number[] = [];
  const stateEvents = ['connectionstatechange', 'iceconnectionstatechange', 'icegatheringstatechange'];
  const stateChanged = () => {
    if (stopped || watchedPeer !== call.peerConn) return;
    update({ ...(last || projectCallQuality(undefined).quality), iceErrors: [...iceErrors], connection: watchedPeer?.connectionState || 'unavailable', ice: watchedPeer?.iceConnectionState || 'unavailable', gathering: watchedPeer?.iceGatheringState || 'unavailable' });
  };
  const iceError = (event: Event) => {
    if (stopped || event.target !== watchedPeer || watchedPeer !== call.peerConn) return;
    const code = (event as RTCPeerConnectionIceErrorEvent).errorCode;
    if (Number.isInteger(code) && code >= 300 && code <= 799 && iceErrors.length < 8 && !iceErrors.includes(code)) { iceErrors.push(code); stateChanged(); }
  };
  const bindPeer = () => {
    if (watchedPeer === call.peerConn) return;
    for (const event of stateEvents) watchedPeer?.removeEventListener?.(event, stateChanged);
    watchedPeer?.removeEventListener?.('icecandidateerror', iceError);
    watchedPeer = call.peerConn; last = undefined; previous.clear(); iceErrors = [];
    for (const event of stateEvents) watchedPeer?.addEventListener?.(event, stateChanged);
    watchedPeer?.addEventListener?.('icecandidateerror', iceError);
  };
  async function sample() {
    bindPeer(); const peer = call.peerConn;
    try {
      const raw = peer ? await call.getCurrentCallStats() : undefined;
      if (stopped) return;
      if (peer === call.peerConn) {
        const value = projectCallQuality(raw, previous, peer?.connectionState, peer?.iceConnectionState, peer?.iceGatheringState);
        previous = value.counters; last = { ...value.quality, iceErrors: [...iceErrors] }; update(last);
      } else { bindPeer(); stateChanged(); }
    } catch {
      if (stopped) return;
      bindPeer(); previous.clear(); last = { ...projectCallQuality(undefined, previous, call.peerConn?.connectionState, call.peerConn?.iceConnectionState, call.peerConn?.iceGatheringState).quality, error: 'This browser did not provide call measurements.' }; update(last);
    }
    if (!stopped) timer = setTimeout(() => void sample(), interval);
  }
  void sample();
  return () => { stopped = true; clearTimeout(timer); previous.clear(); for (const event of stateEvents) watchedPeer?.removeEventListener?.(event, stateChanged); watchedPeer?.removeEventListener?.('icecandidateerror', iceError); };
}
