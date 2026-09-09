import { CallEvent, CallFeedEvent, type MatrixCall } from 'matrix-js-sdk';

export const streamQualityPresets = {
  automatic: { label: 'Call defaults', width: 0, height: 0, frameRate: 0, maxBitrate: 0 },
  low: { label: 'Lower bandwidth', width: 640, height: 360, frameRate: 15, maxBitrate: 500_000 },
  balanced: { label: 'Balanced', width: 1280, height: 720, frameRate: 30, maxBitrate: 1_500_000 },
  detail: { label: 'More detail', width: 1920, height: 1080, frameRate: 30, maxBitrate: 3_000_000 },
  text: { label: 'Screen text', width: 1920, height: 1080, frameRate: 15, maxBitrate: 2_500_000 },
} as const;
export type StreamQualityPreset = keyof typeof streamQualityPresets;
export type StreamQualityKind = 'camera' | 'screen';
type Outcome = 'unchanged' | 'applied' | 'unsupported' | 'failed' | 'waiting';
type Capture = { width: number | null; height: number | null; frameRate: number | null };
type Limit = { maxBitrate: number | null; maxFramerate: number | null };
export type StreamQualityResult = {
  preset: StreamQualityPreset; available: boolean; enabled: boolean; status: 'ready' | 'waiting' | 'applying' | 'applied' | 'partial' | 'unsupported' | 'failed';
  capture: Capture | null; limits: Limit[]; captureOutcome: Outcome; senderOutcome: Outcome; messages: string[];
};
export type StreamQualitySnapshot = Record<StreamQualityKind, StreamQualityResult>;
type CaptureFields = Pick<MediaTrackConstraints, 'width' | 'height' | 'frameRate'>;
type EncoderFields = Pick<RTCRtpEncodingParameters, 'maxBitrate' | 'maxFramerate'>;
type CaptureRecord = { original: CaptureFields; last: CaptureFields };
type SenderRecord = { structure: string; original: EncoderFields[]; last: EncoderFields[] };
type Session = { choices: Record<StreamQualityKind, StreamQualityPreset>; versions: Record<StreamQualityKind, number>; tracks: WeakMap<MediaStreamTrack, CaptureRecord>; senders: WeakMap<RTCRtpSender, SenderRecord>; queue: Promise<unknown> };
const sessions = new WeakMap<MatrixCall, Session>();
const captureKeys = ['width', 'height', 'frameRate'] as const;
const encoderKeys = ['maxBitrate', 'maxFramerate'] as const;
const kinds = ['camera', 'screen'] as const;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const clone = <T,>(value: T): T => value === undefined ? value : structuredClone(value);
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const first = Object.keys(a).sort(), second = Object.keys(b).sort();
  return first.length === second.length && first.every((key, index) => key === second[index] && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Project only numeric video measurements. Device IDs, labels and RTP data never
 * enter the UI snapshot. The owned browser objects remain inside this controller. */
function captureSettings(track: MediaStreamTrack): Capture | null { try { const settings = track.getSettings(); return { width: finite(settings.width), height: finite(settings.height), frameRate: finite(settings.frameRate) }; } catch { return null; } }
function limits(sender: RTCRtpSender): Limit[] { try { return (sender.getParameters().encodings || []).map(encoding => ({ maxBitrate: finite(encoding.maxBitrate), maxFramerate: finite(encoding.maxFramerate) })); } catch { return []; } }
function empty(preset: StreamQualityPreset): StreamQualityResult { return { preset, available: false, enabled: false, status: 'waiting', capture: null, limits: [], captureOutcome: 'waiting', senderOutcome: 'waiting', messages: [] }; }
function captureFields(value: MediaTrackConstraints): CaptureFields { return Object.fromEntries(captureKeys.filter(key => Object.hasOwn(value, key)).map(key => [key, clone(value[key])])) as CaptureFields; }
function encoderFields(value: RTCRtpEncodingParameters): EncoderFields { return Object.fromEntries(encoderKeys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])); }
function assignField(target: Record<string, any>, key: string, value: unknown) { if (value === undefined) delete target[key]; else target[key] = clone(value); }

export class CallStreamQualityController {
  private readonly session: Session;
  private stopped = false;
  private listeners = new Set<(snapshot: StreamQualitySnapshot) => void>();
  private snapshot: StreamQualitySnapshot;
  private feeds = new Set<NonNullable<MatrixCall['localUsermediaFeed']>>();
  private watchedTracks = new Set<MediaStreamTrack>();
  private observed: Record<StreamQualityKind, { track?: MediaStreamTrack; peer?: RTCPeerConnection; senders: RTCRtpSender[] }> = { camera: { senders: [] }, screen: { senders: [] } };

  constructor(private readonly call: MatrixCall, private readonly current: () => boolean) {
    let session = sessions.get(call);
    if (!session) { session = { choices: { camera: 'automatic', screen: 'automatic' }, versions: { camera: 0, screen: 0 }, tracks: new WeakMap(), senders: new WeakMap(), queue: Promise.resolve() }; sessions.set(call, session); }
    this.session = session;
    this.snapshot = { camera: empty(session.choices.camera), screen: empty(session.choices.screen) };
    for (const type of [CallEvent.FeedsChanged, CallEvent.PeerConnectionCreated, CallEvent.State]) call.on?.(type as any, this.refresh);
    call.on?.(CallEvent.Hangup, this.dispose);
    this.refresh();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: (snapshot: StreamQualitySnapshot) => void) => { this.listeners.add(listener); listener(this.snapshot); return () => { this.listeners.delete(listener); }; };
  private active() { return !this.stopped && this.current() && this.call.state !== 'ended'; }
  private track(kind: StreamQualityKind) {
    const stream = kind === 'camera' ? this.call.localUsermediaStream : this.call.localScreensharingStream;
    const tracks = stream?.getVideoTracks().filter(track => track.kind === 'video' && track.readyState === 'live') || [];
    // A purpose must have exactly one owned video track. Ambiguity must never
    // cause us to modify a different source or a remote track.
    return tracks.length === 1 ? tracks[0] : undefined;
  }
  private senders(track?: MediaStreamTrack) { try { return track ? (this.call.peerConn?.getSenders() || []).filter(sender => sender.track === track) : []; } catch { return []; } }
  private valid(kind: StreamQualityKind, track: MediaStreamTrack, version: number, peer?: RTCPeerConnection, sender?: RTCRtpSender) {
    return this.active() && this.session.versions[kind] === version && this.track(kind) === track && (!peer || this.call.peerConn === peer && peer.signalingState !== 'closed') && (!sender || sender.track === track && this.senders(track).includes(sender));
  }
  private publish(kind: StreamQualityKind, result: StreamQualityResult) { if (!this.active()) return; this.snapshot = { ...this.snapshot, [kind]: result }; for (const listener of this.listeners) listener(this.snapshot); }
  private bind() {
    const nextFeeds = new Set([this.call.localUsermediaFeed, this.call.localScreensharingFeed].filter((feed): feed is NonNullable<typeof feed> => !!feed));
    for (const feed of this.feeds) if (!nextFeeds.has(feed)) { feed.off?.(CallFeedEvent.NewStream, this.refresh); feed.off?.(CallFeedEvent.MuteStateChanged, this.refresh); }
    for (const feed of nextFeeds) if (!this.feeds.has(feed)) { feed.on?.(CallFeedEvent.NewStream, this.refresh); feed.on?.(CallFeedEvent.MuteStateChanged, this.refresh); }
    this.feeds = nextFeeds;
    const tracks = new Set(kinds.map(kind => this.track(kind)).filter((track): track is MediaStreamTrack => !!track));
    for (const track of this.watchedTracks) if (!tracks.has(track)) track.removeEventListener?.('ended', this.refresh);
    for (const track of tracks) if (!this.watchedTracks.has(track)) track.addEventListener?.('ended', this.refresh);
    this.watchedTracks = tracks;
  }
  private refresh = () => {
    if (!this.active()) return;
    this.bind();
    for (const kind of kinds) {
      const track = this.track(kind), peer = this.call.peerConn, senders = this.senders(track), previous = this.observed[kind];
      const changed = previous.track !== track || previous.peer !== peer || previous.senders.length !== senders.length || previous.senders.some((sender, index) => sender !== senders[index]);
      this.observed[kind] = { track, peer, senders };
      if (!track) { this.session.versions[kind]++; this.publish(kind, { ...empty(this.session.choices[kind]), messages: [kind === 'camera' ? 'Enable your camera to apply this choice. No camera will be opened by this control.' : 'Start screen sharing to apply this choice. Your selected screen will stay the same.'] }); }
      else if (changed || this.snapshot[kind].senderOutcome === 'waiting') void this.set(kind, this.session.choices[kind]);
      else this.publish(kind, { ...this.snapshot[kind], enabled: track.enabled, capture: captureSettings(track), limits: senders.flatMap(limits) });
    }
  };

  set(kind: StreamQualityKind, preset: StreamQualityPreset): Promise<StreamQualityResult | null> {
    if (!kinds.includes(kind) || !Object.hasOwn(streamQualityPresets, preset)) return Promise.reject(new Error('Choose a supported stream quality preset.'));
    if (!this.active()) return Promise.reject(new Error('This call is no longer active.'));
    this.session.choices[kind] = preset;
    const version = ++this.session.versions[kind], track = this.track(kind);
    if (!track) { const result = { ...empty(preset), messages: [kind === 'camera' ? 'This choice will apply when you enable your camera in this call.' : 'This choice will apply when you start sharing your screen in this call.'] }; this.publish(kind, result); return Promise.resolve(result); }
    this.publish(kind, { ...this.snapshot[kind], preset, available: true, enabled: track.enabled, status: 'applying', messages: [] });
    const task = this.session.queue.catch(() => {}).then(() => this.apply(kind, preset, track, version));
    this.session.queue = task;
    return task;
  }

  private async capture(kind: StreamQualityKind, preset: StreamQualityPreset, track: MediaStreamTrack, version: number): Promise<{ outcome: Outcome; message?: string }> {
    let record = this.session.tracks.get(track);
    if (preset === 'automatic' && !record) return { outcome: 'unchanged' };
    if (typeof track.applyConstraints !== 'function' || typeof track.getConstraints !== 'function') return { outcome: 'unsupported', message: 'This browser cannot change capture settings on this video source.' };
    try {
      const constraints = track.getConstraints(), before = captureFields(constraints);
      if (!record) { record = { original: clone(before), last: clone(before) }; this.session.tracks.set(track, record); }
      // Preserve a setting changed by the SDK or another owner between requests.
      for (const key of captureKeys) if (!same(before[key], record.last[key])) assignField(record.original, key, before[key]);
      const desired = streamQualityPresets[preset], fields: CaptureFields = preset === 'automatic' ? record.original : { width: { ideal: desired.width, max: desired.width }, height: { ideal: desired.height, max: desired.height }, frameRate: { ideal: desired.frameRate, max: desired.frameRate } };
      for (const key of captureKeys) assignField(constraints, key, fields[key]);
      if (!this.valid(kind, track, version)) return { outcome: 'waiting' };
      if (!same(before, fields)) await track.applyConstraints(constraints);
      // A newer request may have arrived while the browser applied this one.
      // Remember our completed write so it is not mistaken for an external
      // owner's baseline by the next serialized request.
      record.last = clone(fields);
      if (!this.valid(kind, track, version)) return { outcome: 'waiting' };
      if (!same(captureFields(track.getConstraints()), fields)) return { outcome: 'unsupported', message: 'The browser did not retain the requested capture constraints. The actual values are shown below.' };
      return { outcome: 'applied' };
    } catch (error) {
      return { outcome: (error as Error).name === 'NotSupportedError' ? 'unsupported' : 'failed', message: (error as Error).name === 'OverconstrainedError' ? 'This source cannot satisfy the requested capture size or frame rate.' : 'The browser could not change capture settings. Send limits are checked separately.' };
    }
  }

  private async sender(kind: StreamQualityKind, preset: StreamQualityPreset, track: MediaStreamTrack, version: number, peer: RTCPeerConnection, sender: RTCRtpSender, senderCount: number): Promise<{ outcome: Outcome; message?: string }> {
    if (!this.valid(kind, track, version, peer, sender)) return { outcome: 'waiting' };
    if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return { outcome: 'unsupported', message: 'This browser cannot set video send limits.' };
    try {
      // Always get a fresh transaction immediately before setParameters. Never
      // replace encodings, edit codecs, enable a sender, or modify ICE/encryption.
      const parameters = sender.getParameters(), encodings = parameters.encodings;
      if (!encodings?.length || encodings.length > 16) return { outcome: 'waiting', message: 'Video send limits are waiting for the call sender to become ready.' };
      const structure = JSON.stringify(encodings.map(encoding => encoding.rid ?? null)), before = encodings.map(encoderFields);
      let record = this.session.senders.get(sender);
      if (preset === 'automatic' && !record) return { outcome: 'unchanged' };
      if (!record || record.structure !== structure) { record = { structure, original: clone(before), last: clone(before) }; this.session.senders.set(sender, record); }
      const desired = streamQualityPresets[preset];
      for (let index = 0; index < encodings.length; index++) for (const key of encoderKeys) {
        if (!same(before[index][key], record.last[index][key])) assignField(record.original[index], key, before[index][key]);
        const original = record.original[index][key], requested = key === 'maxBitrate' ? Math.floor(desired.maxBitrate / (encodings.length * senderCount)) : desired.frameRate;
        const value = preset === 'automatic' ? original : typeof original === 'number' && Number.isFinite(original) ? Math.min(original, requested) : requested;
        assignField(encodings[index], key, value);
      }
      if (!this.valid(kind, track, version, peer, sender)) return { outcome: 'waiting' };
      const next = encodings.map(encoderFields);
      if (!same(before, next)) await sender.setParameters(parameters);
      record.last = clone(next);
      if (!this.valid(kind, track, version, peer, sender)) return { outcome: 'waiting' };
      const actual = sender.getParameters().encodings;
      if (actual?.length !== next.length || actual.some((encoding, index) => encoderKeys.some(key => !same(encoding[key], next[index][key])))) return { outcome: 'unsupported', message: 'The browser did not retain the requested video send limits.' };
      return { outcome: 'applied' };
    } catch (error) { return { outcome: (error as Error).name === 'NotSupportedError' ? 'unsupported' : 'failed', message: 'The browser rejected video send limits. Capture settings may still have changed.' }; }
  }

  private async apply(kind: StreamQualityKind, preset: StreamQualityPreset, track: MediaStreamTrack, version: number): Promise<StreamQualityResult | null> {
    if (!this.valid(kind, track, version)) return null;
    const peer = this.call.peerConn;
    const capture = await this.capture(kind, preset, track, version);
    if (!this.valid(kind, track, version) || this.call.peerConn !== peer) return null;
    const senders = this.senders(track), outcomes: { outcome: Outcome; message?: string }[] = [];
    if (peer) for (const sender of senders) {
      if (!this.valid(kind, track, version, peer, sender)) return null;
      outcomes.push(await this.sender(kind, preset, track, version, peer, sender, senders.length));
      if (!this.valid(kind, track, version, peer, sender)) return null;
    }
    if (!this.valid(kind, track, version, peer)) return null;
    const currentSenders = this.senders(track);
    if (currentSenders.length !== senders.length || senders.some((sender, index) => currentSenders[index] !== sender)) return null;
    if (!outcomes.length) outcomes.push({ outcome: 'waiting', message: 'Video send limits will apply when this source has an active call sender.' });
    const order: Outcome[] = ['failed', 'unsupported', 'waiting', 'applied', 'unchanged'];
    const senderOutcome = order.find(outcome => outcomes.some(value => value.outcome === outcome))!;
    const actual = captureSettings(track), requested = streamQualityPresets[preset];
    const messages = [...new Set([capture.message, ...outcomes.map(value => value.message)].filter((message): message is string => !!message))];
    const mismatch = preset !== 'automatic' && !!actual && (actual.width !== null && actual.width > requested.width || actual.height !== null && actual.height > requested.height || actual.frameRate !== null && actual.frameRate > requested.frameRate + 1);
    if (mismatch) messages.push('The capture remains above the requested size or frame rate. The actual values are shown below.');
    const good = (outcome: Outcome) => outcome === 'applied' || outcome === 'unchanged';
    const status = good(capture.outcome) && good(senderOutcome) && !mismatch ? 'applied' : good(capture.outcome) || outcomes.some(value => good(value.outcome)) ? 'partial' : capture.outcome === 'unsupported' && senderOutcome === 'unsupported' ? 'unsupported' : 'failed';
    const result: StreamQualityResult = { preset, available: true, enabled: track.enabled, status, capture: actual, limits: senders.flatMap(limits), captureOutcome: capture.outcome, senderOutcome, messages };
    this.publish(kind, result);
    return result;
  }
  dispose = () => {
    if (this.stopped) return;
    this.stopped = true;
    for (const type of [CallEvent.FeedsChanged, CallEvent.PeerConnectionCreated, CallEvent.State]) this.call.off?.(type as any, this.refresh);
    this.call.off?.(CallEvent.Hangup, this.dispose);
    for (const feed of this.feeds) { feed.off?.(CallFeedEvent.NewStream, this.refresh); feed.off?.(CallFeedEvent.MuteStateChanged, this.refresh); }
    for (const track of this.watchedTracks) track.removeEventListener?.('ended', this.refresh);
    this.feeds.clear(); this.watchedTracks.clear(); this.listeners.clear();
    // Streams and senders belong to MatrixCall. Disposing controls never stops,
    // replaces, unmutes, clones, or otherwise takes ownership of those objects.
  };
}
