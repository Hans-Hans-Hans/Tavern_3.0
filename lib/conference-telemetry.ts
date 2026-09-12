import { CALL_TELEMETRY_BIND, CALL_TELEMETRY_READY, CALL_AUDIO_SET, CALL_AUDIO_ACK, emptyConferenceMetrics, parseConferenceTelemetry, telemetryNonce, type ConferenceTelemetry, type ConferenceFailure } from './conference-telemetry-protocol';
export type { ConferenceTelemetry, ConferenceParticipant, ConferenceMetrics, ConferenceFailure } from './conference-telemetry-protocol';

/** Observations and acknowledged local playback controls for this exact widget.
 * This channel grants no native membership or remote moderation authority. */
export function observeConferenceTelemetry({ iframe, widgetId, session, roomId, isCurrent, onUpdate }: {
  iframe: HTMLIFrameElement; widgetId: string; session: string; roomId: string;
  isCurrent: () => boolean; onUpdate: (value: ConferenceTelemetry | null) => void;
}): (() => void) & { setDeafened: (deafened: boolean) => Promise<void> } {
  if (!telemetryNonce(widgetId) || !telemetryNonce(session)) throw new Error('Invalid conference telemetry binding.');
  const source = iframe.contentWindow, origin = location.origin;
  let stopped = false, sequence = 0, received = 0, published = false, document = '', unavailable = false;
  let failure: ConferenceFailure | null = null;
  let audioSequence = 0, audioReady = false;
  let audioPending: { sequence: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  const cancelAudio = () => { if (audioPending) { clearTimeout(audioPending.timer); audioPending.reject(new Error('Voice audio controls are no longer available.')); audioPending = null; } };
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
    cancelAudio(); audioReady = false;
    document = crypto.randomUUID(); sequence = 0; clear(true);
    try { source?.postMessage({ type: CALL_TELEMETRY_BIND, version: 1, widgetId, session, roomId, document }, origin); } catch { /* unavailable frame */ }
  };
  const stop = () => { if (stopped) return; stopped = true; cancelAudio(); window.removeEventListener('message', message); iframe.removeEventListener('load', bind); clearInterval(timer); clear(); };
  const message = (event: MessageEvent) => {
    if (!current()) { stop(); return; }
    if (!source || event.source !== source || event.origin !== origin) return;
    const ready = event.data;
    if (ready && typeof ready === 'object' && Object.keys(ready).length === 8 && ready.type === CALL_AUDIO_ACK && ready.version === 1 && ready.widgetId === widgetId && ready.session === session && ready.roomId === roomId && ready.document === document && ready.sequence === audioPending?.sequence && typeof ready.applied === 'boolean' && audioPending) {
      const pending = audioPending; audioPending = null; clearTimeout(pending.timer);
      if (ready.applied) pending.resolve(); else pending.reject(new Error('The call could not change its audio output. Try again when it is connected.'));
      return;
    }
    if (ready && typeof ready === 'object' && Object.keys(ready).length === 5 && ready.type === CALL_TELEMETRY_READY && ready.version === 1 && ready.widgetId === widgetId && ready.session === session && ready.roomId === roomId) { bind(); return; }
    const value = parseConferenceTelemetry(event.data);
    if (!value || value.widgetId !== widgetId || value.session !== session || value.roomId !== roomId || value.document !== document || value.sequence <= sequence) return;
    sequence = value.sequence; received = performance.now(); published = true; unavailable = false; failure ??= value.failure ?? null;
    audioReady = value.connected && !failure && typeof value.deafened === 'boolean';
    const { type: _type, version: _version, widgetId: _widget, session: _session, roomId: _room, document: _document, sequence: _sequence, ...telemetry } = value;
    onUpdate({ ...telemetry, failure });
  };
  onUpdate(null);
  window.addEventListener('message', message);
  const timer = window.setInterval(() => { if (!current()) stop(); else if (published && performance.now() - received > 5000) clear(true); }, 250);
  iframe.addEventListener('load', bind); bind();
  return Object.assign(stop, { setDeafened(deafened: boolean): Promise<void> {
    if (!current() || !source || !document || !published || !audioReady || performance.now() - received > 5000 || audioPending || typeof deafened !== 'boolean') return Promise.reject(new Error('Voice audio controls are not ready for this call.'));
    return new Promise((resolve, reject) => {
      const request = ++audioSequence;
      const timer = setTimeout(() => { if (audioPending?.sequence === request) { audioPending = null; reject(new Error('The call did not confirm its audio output change.')); } }, 4000);
      audioPending = { sequence: request, resolve, reject, timer };
      try { source.postMessage({ type: CALL_AUDIO_SET, version: 1, widgetId, session, roomId, document, sequence: request, deafened }, origin); }
      catch { cancelAudio(); }
    });
  } });
}
