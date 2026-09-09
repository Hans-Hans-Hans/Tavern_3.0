import type { MatrixCall } from 'matrix-js-sdk';

type Counter = { timestamp: number; bytes?: number; received?: number; lost?: number };
export type QualityBaseline = Map<string, Counter>;
export type CallQuality = { connection: string; ice: string; localRoute: string | null; roundTripMs: number | null; jitterMs: number | null; downloadKbps: number | null; uploadKbps: number | null; receiveLossPercent: number | null; sampledAt: number; available: boolean; error: string };
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => numeric(value) && value >= 0;
const rounded = (value: number) => Math.round(value * 10) / 10;

export function projectCallQuality(raw: unknown, previous: QualityBaseline = new Map(), connection = 'unavailable', ice = 'unavailable') {
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
  const result: CallQuality = { connection, ice, localRoute: ['relay', 'srflx', 'prflx', 'host'].includes(local?.candidateType) ? local!.candidateType : null,
    roundTripMs: pair && nonnegative(pair.currentRoundTripTime) ? rounded(pair.currentRoundTripTime * 1000) : null,
    jitterMs: jitter === null ? null : rounded(jitter), downloadKbps: downloadSamples ? rounded(download) : null, uploadKbps: uploadSamples ? rounded(upload) : null,
    receiveLossPercent: lossSamples && received + lost > 0 ? rounded(lost * 100 / (received + lost)) : null, sampledAt: Date.now(), available: rows.length > 0, error: '' };
  // Only counters and explicitly selected metrics survive this projection. ICE
  // addresses, ports, certificates and complete reports are never retained.
  return { quality: result, counters };
}

export function watchCallQuality(call: Pick<MatrixCall, 'getCurrentCallStats' | 'peerConn'>, update: (value: CallQuality) => void, interval = 2000) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, previous: QualityBaseline = new Map();
  async function sample() {
    try {
      const raw = call.peerConn ? await call.getCurrentCallStats() : undefined;
      if (stopped) return;
      const value = projectCallQuality(raw, previous, call.peerConn?.connectionState, call.peerConn?.iceConnectionState);
      previous = value.counters; update(value.quality);
    } catch {
      if (stopped) return;
      previous.clear(); update({ ...projectCallQuality(undefined, previous, call.peerConn?.connectionState, call.peerConn?.iceConnectionState).quality, error: 'This browser did not provide call measurements.' });
    }
    if (!stopped) timer = setTimeout(() => void sample(), interval);
  }
  void sample();
  return () => { stopped = true; clearTimeout(timer); previous.clear(); };
}
