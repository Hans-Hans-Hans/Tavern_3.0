import { CALL_TELEMETRY_BIND, CALL_TELEMETRY_READY, emptyConferenceMetrics, parseConferenceTelemetry, telemetryNonce, type ConferenceTelemetry, type ConferenceFailure } from './conference-telemetry-protocol';
export type { ConferenceTelemetry, ConferenceParticipant, ConferenceMetrics, ConferenceFailure } from './conference-telemetry-protocol';

/** A read-only channel from this exact mounted widget. No widget permissions,
 * media ownership or native membership authority are granted by telemetry. */
export function observeConferenceTelemetry({ iframe, widgetId, session, roomId, isCurrent, onUpdate }: {
  iframe: HTMLIFrameElement; widgetId: string; session: string; roomId: string;
  isCurrent: () => boolean; onUpdate: (value: ConferenceTelemetry | null) => void;
}): () => void {
  if (!telemetryNonce(widgetId) || !telemetryNonce(session)) throw new Error('Invalid conference telemetry binding.');
  const source = iframe.contentWindow, origin = location.origin;
  let stopped = false, sequence = 0, received = 0, published = false, document = '', unavailable = false;
  let failure: ConferenceFailure | null = null;
  const clear = (retainFailure = false) => {
    if (!published) return;
    if (retainFailure && failure) {
      if (!unavailable) { unavailable = true; onUpdate({ connected: false, reconnecting: false, participants: [], complete: false, e2eeEnabled: null, metrics: emptyConferenceMetrics(), failure }); }
    } else { published = false; failure = null; onUpdate(null); }
  };
  const current = () => !stopped && iframe.contentWindow === source && isCurrent();
  // WindowProxy survives a document reload. A fresh challenge delivered to the
  // current document prevents old queued packets from becoming new telemetry.
  const bind = () => {
    if (!current()) { stop(); return; }
    document = crypto.randomUUID(); sequence = 0; clear(true);
    try { source?.postMessage({ type: CALL_TELEMETRY_BIND, version: 1, widgetId, session, roomId, document }, origin); } catch { /* unavailable frame */ }
  };
  const stop = () => { if (stopped) return; stopped = true; window.removeEventListener('message', message); iframe.removeEventListener('load', bind); clearInterval(timer); clear(); };
  const message = (event: MessageEvent) => {
    if (!current()) { stop(); return; }
    if (!source || event.source !== source || event.origin !== origin) return;
    const ready = event.data;
    if (ready && typeof ready === 'object' && Object.keys(ready).length === 5 && ready.type === CALL_TELEMETRY_READY && ready.version === 1 && ready.widgetId === widgetId && ready.session === session && ready.roomId === roomId) { bind(); return; }
    const value = parseConferenceTelemetry(event.data);
    if (!value || value.widgetId !== widgetId || value.session !== session || value.roomId !== roomId || value.document !== document || value.sequence <= sequence) return;
    sequence = value.sequence; received = performance.now(); published = true; unavailable = false; failure ??= value.failure ?? null;
    const { type: _type, version: _version, widgetId: _widget, session: _session, roomId: _room, document: _document, sequence: _sequence, ...telemetry } = value;
    onUpdate({ ...telemetry, failure });
  };
  onUpdate(null);
  window.addEventListener('message', message);
  const timer = window.setInterval(() => { if (!current()) stop(); else if (published && performance.now() - received > 5000) clear(true); }, 250);
  iframe.addEventListener('load', bind); bind();
  return stop;
}
