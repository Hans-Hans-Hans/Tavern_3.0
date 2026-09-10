import { parseConferenceTelemetry, telemetryNonce, type ConferenceTelemetry } from './conference-telemetry-protocol';
export type { ConferenceTelemetry, ConferenceParticipant, ConferenceMetrics } from './conference-telemetry-protocol';

/** A read-only channel from this exact mounted widget. No widget permissions,
 * media ownership or native membership authority are granted by telemetry. */
export function observeConferenceTelemetry({ iframe, widgetId, session, roomId, isCurrent, onUpdate }: {
  iframe: HTMLIFrameElement; widgetId: string; session: string; roomId: string;
  isCurrent: () => boolean; onUpdate: (value: ConferenceTelemetry | null) => void;
}): () => void {
  if (!telemetryNonce(widgetId) || !telemetryNonce(session)) throw new Error('Invalid conference telemetry binding.');
  const source = iframe.contentWindow, origin = location.origin;
  let stopped = false, sequence = 0, received = 0, published = false;
  const clear = () => { if (published) { published = false; onUpdate(null); } };
  const current = () => !stopped && iframe.contentWindow === source && isCurrent();
  const stop = () => { if (stopped) return; stopped = true; window.removeEventListener('message', message); clearInterval(timer); clear(); };
  const message = (event: MessageEvent) => {
    if (!current()) { stop(); return; }
    if (!source || event.source !== source || event.origin !== origin) return;
    const value = parseConferenceTelemetry(event.data);
    if (!value || value.widgetId !== widgetId || value.session !== session || value.roomId !== roomId || value.sequence <= sequence) return;
    sequence = value.sequence; received = performance.now(); published = true;
    const { type: _type, version: _version, widgetId: _widget, session: _session, roomId: _room, sequence: _sequence, ...telemetry } = value;
    onUpdate(telemetry);
  };
  onUpdate(null);
  window.addEventListener('message', message);
  const timer = window.setInterval(() => { if (!current()) stop(); else if (published && performance.now() - received > 5000) clear(); }, 250);
  return stop;
}
