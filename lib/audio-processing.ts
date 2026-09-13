export const audioProcessingKeys = ['noiseSuppression', 'echoCancellation', 'autoGainControl'] as const;
export type AudioProcessing = Record<typeof audioProcessingKeys[number], boolean>;
export type AudioProcessingReport = { state: 'waiting' | 'applying' | 'applied' | 'partial' | 'failed'; noiseSuppression: boolean | null; echoCancellation: boolean | null; autoGainControl: boolean | null };
export const speechProcessing: AudioProcessing = { noiseSuppression: true, echoCancellation: true, autoGainControl: true };
export const musicProcessing: AudioProcessing = { noiseSuppression: false, echoCancellation: true, autoGainControl: false };
const storageKey = 'tavern.audio-processing', changeEvent = 'tavern:audio-processing';
let cached: AudioProcessing = { ...speechProcessing };
const browser = (): Window | undefined => typeof window === 'undefined' ? undefined : window;
export function readAudioProcessing(host = browser()): AudioProcessing {
  let value: any;
  try { value = JSON.parse(host?.localStorage?.getItem(storageKey) || '{}'); } catch { value = {}; }
  const next = Object.fromEntries(audioProcessingKeys.map(key => [key, typeof value?.[key] === 'boolean' ? value[key] : speechProcessing[key]])) as AudioProcessing;
  if (audioProcessingKeys.some(key => cached[key] !== next[key])) cached = next;
  return cached;
}
export function saveAudioProcessing(patch: Partial<AudioProcessing>, host = browser()) {
  if (!host || !Object.keys(patch).length || Object.entries(patch).some(([key, value]) => !audioProcessingKeys.includes(key as any) || typeof value !== 'boolean')) throw new Error('Choose valid microphone processing settings.');
  const next = { ...readAudioProcessing(host), ...patch };
  try { host.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { throw new Error('Your browser could not save microphone settings.'); }
  cached = next; host.dispatchEvent(new Event(changeEvent));
}
export function subscribeAudioProcessing(listener: () => void, host = browser()) {
  if (!host || typeof host.addEventListener !== 'function') return () => {};
  const storage = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) listener(); };
  host.addEventListener(changeEvent, listener); host.addEventListener('storage', storage);
  return () => { host.removeEventListener(changeEvent, listener); host.removeEventListener('storage', storage); };
}
export function audioProcessingConstraints(settings: AudioProcessing): MediaTrackConstraints {
  return Object.fromEntries(audioProcessingKeys.map(key => [key, { ideal: settings[key] }]));
}
export const emptyAudioProcessingReport = (): AudioProcessingReport => ({ state: 'waiting', noiseSuppression: null, echoCancellation: null, autoGainControl: null });

export type MicrophoneRestart = { owner: object; current: () => boolean; run: (settings: AudioProcessing) => Promise<MediaStreamTrack | null> };
/** Changes the existing microphone. An optional owning SDK can replace capture
 * when a browser cannot change processing in place; mute remains SDK-owned. */
export class MicrophoneProcessingController {
  private stopped = false;
  private track: MediaStreamTrack | null = null;
  private owner: object | null = null;
  private revision = 0;
  private restarting = false;
  private preferenceKey = '';
  private report = emptyAudioProcessingReport();
  private queues = new WeakMap<object, Promise<void>>();
  constructor(private current: () => boolean, private supported: () => MediaTrackSupportedConstraints, private changed: (report: AudioProcessingReport) => void) {}
  private publish(report: AudioProcessingReport) {
    if (!this.stopped && this.current() && JSON.stringify(report) !== JSON.stringify(this.report)) { this.report = report; this.changed(report); }
  }
  refresh(track: MediaStreamTrack | null | undefined, settings: AudioProcessing, restart?: MicrophoneRestart) {
    if (this.stopped || !this.current()) return;
    const next = track?.kind === 'audio' && track.readyState === 'live' ? track : null;
    const owner = restart?.owner || next;
    const key = JSON.stringify(audioProcessingKeys.map(name => settings[name]));
    if (this.owner === owner && this.preferenceKey === key && (this.track === next || this.restarting)) return;
    this.track = next; this.owner = owner; this.preferenceKey = key; this.restarting = false;
    const revision = ++this.revision, requested = { ...settings };
    if (!next) { this.publish(emptyAudioProcessingReport()); return; }
    const owns = () => !this.stopped && this.current() && this.owner === owner && this.revision === revision && (restart ? restart.current() : next.readyState === 'live');
    this.publish({ ...emptyAudioProcessingReport(), state: 'applying' });
    const pending = (this.queues.get(owner!) || Promise.resolve()).catch(() => {}).then(async () => {
      if (!owns()) return;
      try {
        const supported = this.supported(), keys = audioProcessingKeys.filter(name => supported[name] === true);
        let failed = false;
        if (keys.length && typeof next.applyConstraints === 'function') {
          const constraints = { ...next.getConstraints() };
          for (const name of keys) constraints[name] = { ideal: requested[name] };
          try { await next.applyConstraints(constraints); } catch { failed = true; }
        }
        if (!owns()) return;
        let actual = next.getSettings();
        if (restart && keys.some(name => actual[name] !== requested[name])) {
          this.restarting = true;
          const replacement = await restart.run(requested);
          if (!owns()) return;
          if (!replacement || replacement.kind !== 'audio' || replacement.readyState !== 'live') throw new Error('Microphone replacement unavailable');
          this.track = replacement; actual = replacement.getSettings(); failed = false;
        }
        if (failed) throw new Error('Microphone processing unavailable');
        const report = emptyAudioProcessingReport();
        for (const name of audioProcessingKeys) report[name] = typeof actual[name] === 'boolean' ? actual[name] as boolean : null;
        report.state = audioProcessingKeys.every(name => supported[name] === true && report[name] === requested[name]) ? 'applied' : 'partial';
        this.publish(report);
      } catch { if (owns()) this.publish({ ...emptyAudioProcessingReport(), state: 'failed' }); }
      finally { if (this.revision === revision) this.restarting = false; }
    });
    this.queues.set(owner!, pending);
  }
  dispose() { this.stopped = true; this.track = null; this.owner = null; }
}
