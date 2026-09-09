/** Local interaction idle only: never reads media or infers whether anyone speaks. */
export function createCallIdleTimer(timeoutSeconds: number, onWarning: (seconds: number | null) => void, onExpire: () => void, now: () => number = () => performance.now()) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 3600) throw new Error('Choose an idle timeout between one minute and one hour.');
  const duration = timeoutSeconds * 1000, grace = 30000;
  let deadline = now() + duration, stopped = false, warning = false;
  return {
    activity() { if (stopped) return; deadline = now() + duration; if (warning) onWarning(null); warning = false; },
    check() {
      if (stopped) return;
      const time = now();
      // A suspended/backgrounded browser must still get a warning interval.
      if (!warning && time >= deadline - grace) { warning = true; if (time >= deadline) deadline = time + grace; }
      if (time >= deadline) { stopped = true; onWarning(null); onExpire(); }
      else if (warning) onWarning(Math.ceil((deadline - time) / 1000));
    },
    stop() { stopped = true; },
  };
}

export function monitorCallInteraction(frame: HTMLIFrameElement | null, timeoutSeconds: number, onWarning: (seconds: number | null) => void, onExpire: () => void) {
  const timer = createCallIdleTimer(timeoutSeconds, onWarning, onExpire);
  let frameDocument: Document | null = null;
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
  const activity = (event: Event) => { if (event.isTrusted) timer.activity(); };
  const attach = (doc: Document | null) => { if (doc) for (const name of events) doc.addEventListener(name, activity, { capture: true, passive: true }); };
  const detach = (doc: Document | null) => { if (doc) for (const name of events) doc.removeEventListener(name, activity, true); };
  const loaded = () => {
    let next: Document | null = null;
    try { next = frame?.contentDocument || null; } catch { /* Cross-origin navigation is not treated as activity. */ }
    if (next === document) next = null;
    if (next === frameDocument) return;
    detach(frameDocument); frameDocument = next; attach(frameDocument);
  };
  attach(document); loaded(); frame?.addEventListener('load', loaded);
  const interval = window.setInterval(() => timer.check(), 1000);
  return Object.assign(() => { timer.stop(); window.clearInterval(interval); frame?.removeEventListener('load', loaded); detach(document); detach(frameDocument); frameDocument = null; }, { activity: () => timer.activity() });
}

type CallSnapshot = { generation: number; roomId: string | null; phase: string };
export function idleConferenceEnded(generation: number, snapshot: () => CallSnapshot) {
  const current = snapshot(); return current.generation === generation && current.roomId === null && current.phase === 'idle';
}
/** The passed close operation must belong to this generation, never a mutable ref. */
export async function leaveIdleConference(roomId: string, generation: number, close: (() => Promise<boolean>) | null, snapshot: () => CallSnapshot) {
  const current = snapshot();
  if (!close || current.generation !== generation || current.roomId !== roomId || current.phase !== 'joined') return false;
  return await close() && idleConferenceEnded(generation, snapshot);
}
