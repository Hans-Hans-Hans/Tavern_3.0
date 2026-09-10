import { conferenceSnapshot, subscribeConference } from './conference-session';
import type { ConferenceDevices } from './conference';
import type { ConferenceParticipant, ConferenceTelemetry } from './conference-telemetry';

export type VoiceParticipantState = Readonly<{ speaking: boolean | null; muted: boolean | null; camera: boolean | null; sharing: boolean | null; deafened: boolean | null }>;
const unknown: VoiceParticipantState = Object.freeze({ speaking: null, muted: null, camera: null, sharing: null, deafened: null });
export type VoiceDockState = Readonly<{ roomId: string; generation: number; phase: 'joining' | 'connected' | 'reconnecting' | 'closing' | 'error' | 'unknown'; microphone: boolean | null; busy: boolean; ready: boolean }>;
type Binding = { roomId: string; generation: number; isCurrent: () => boolean; setMicrophone: (enabled: boolean) => Promise<void>; disconnect: () => Promise<unknown>; openSettings: () => void };
type Update = { telemetry?: ConferenceTelemetry | null; devices?: ConferenceDevices; busy?: boolean; ready?: boolean };
type Active = ReturnType<typeof conferenceSnapshot>;

/** One existing widget publishes here. This store never opens a call, reads a
 * microphone, or invents MatrixRTC membership. Room listeners stay local. */
export function createVoiceSidebarStore(active: () => Active, subscribeActive: (fn: () => void) => () => void) {
  const listeners = new Map<string, Set<() => void>>(), dockListeners = new Set<() => void>();
  const owners = new WeakMap<VoiceDockState, Binding>();
  let binding: Binding | null = null, dock: VoiceDockState | null = null, telemetry: ConferenceTelemetry | null = null;
  let devices: ConferenceDevices = {}, busy = false, ready = false, operation: object | null = null;
  let detachActive = () => {};
  let peers = new Map<string, ConferenceParticipant[]>(), cached = new Map<string, VoiceParticipantState>();
  const valid = () => !!binding && binding.isCurrent() && active().roomId === binding.roomId && active().generation === binding.generation && active().phase !== 'idle';
  const notifyRoom = (roomId: string) => listeners.get(roomId)?.forEach(fn => fn());
  const refreshDock = () => {
    const session = active();
    const phase: VoiceDockState['phase'] = session.phase === 'closing' ? 'closing' : session.phase === 'error' || telemetry?.failure ? 'error' :
      telemetry?.reconnecting ? 'reconnecting' : telemetry?.connected ? 'connected' : session.phase === 'joining' ? 'joining' : 'unknown';
    const next: VoiceDockState | null = valid() ? { roomId: binding!.roomId, generation: binding!.generation, phase, microphone: typeof devices.audio_enabled === 'boolean' ? devices.audio_enabled : null, busy: busy || !!operation, ready } : null;
    if (dock && owners.get(dock) !== binding || JSON.stringify(next) !== JSON.stringify(dock)) { dock = next; if (dock && binding) owners.set(dock, binding); dockListeners.forEach(fn => fn()); }
  };
  const readDock = () => valid() ? dock : null;
  const owns = (value: VoiceDockState) => valid() && owners.get(value) === binding;
  function participant(roomId: string, userId: string, deviceIds: readonly string[]): VoiceParticipantState {
    if (!valid() || binding!.roomId !== roomId || !telemetry?.connected || telemetry.failure || !deviceIds.length) return unknown;
    const matches = (peers.get(userId) || []).filter(peer => deviceIds.includes(peer.deviceId));
    if (!matches.length) return unknown;
    const complete = telemetry.complete && new Set(matches.map(peer => peer.deviceId)).size === deviceIds.length;
    const any = (key: 'speaking' | 'microphoneEnabled' | 'cameraEnabled' | 'screenShareEnabled') => matches.some(peer => peer[key]) ? true : complete ? false : null;
    const microphone = any('microphoneEnabled');
    const next: VoiceParticipantState = { speaking: any('speaking'), muted: microphone === null ? null : !microphone, camera: any('cameraEnabled'), sharing: any('screenShareEnabled'), deafened: null };
    const key = JSON.stringify([userId, deviceIds]), previous = cached.get(key);
    if (previous && Object.keys(next).every(key => next[key as keyof VoiceParticipantState] === previous[key as keyof VoiceParticipantState])) return previous;
    if (cached.size >= 256) cached.clear();
    cached.set(key, Object.freeze(next)); return next;
  }
  function bind(value: Binding) {
    detachActive();
    const previousRoom = binding?.roomId;
    binding = value; telemetry = null; devices = {}; busy = false; ready = false; operation = null; peers.clear(); cached.clear();
    let disposed = false;
    const current = () => !disposed && binding === value && valid();
    const refresh = () => { refreshDock(); if (!current()) notifyRoom(value.roomId); };
    const off = subscribeActive(refresh);
    detachActive = off;
    refreshDock(); if (previousRoom) notifyRoom(previousRoom); notifyRoom(value.roomId);
    return {
      update(patch: Update) {
        if (!current()) return;
        if (Object.hasOwn(patch, 'telemetry')) {
          telemetry = patch.telemetry || null; peers = new Map();
          for (const peer of telemetry?.participants || []) { const entries = peers.get(peer.userId) || []; entries.push(peer); peers.set(peer.userId, entries); }
          notifyRoom(value.roomId);
        }
        if (patch.devices) devices = { ...devices, ...patch.devices };
        if (patch.busy !== undefined) busy = patch.busy;
        if (patch.ready !== undefined) ready = patch.ready;
        refreshDock();
      },
      dispose() {
        if (disposed) return; disposed = true; off();
        if (binding !== value) return;
        binding = null; telemetry = null; peers.clear(); cached.clear(); operation = null;
        refreshDock(); notifyRoom(value.roomId);
      },
    };
  }
  async function microphone(expected: VoiceDockState, enabled: boolean) {
    const owner = binding;
    if (!owner || !valid() || expected !== dock || !ready || busy || operation || typeof devices.audio_enabled !== 'boolean' || active().phase === 'closing') throw new Error('Voice controls are no longer available for this call.');
    const token = {}; operation = token; refreshDock();
    try { await owner.setMicrophone(enabled); }
    finally { if (binding === owner && operation === token) { operation = null; refreshDock(); } }
  }
  function action(expected: VoiceDockState, kind: 'disconnect' | 'settings') {
    if (!binding || !valid() || expected !== dock || active().phase === 'closing') throw new Error('This voice call is no longer available.');
    return kind === 'disconnect' ? binding.disconnect() : binding.openSettings();
  }
  return { bind, readDock, owns, participant, microphone, action,
    subscribeDock(fn: () => void) { dockListeners.add(fn); return () => { dockListeners.delete(fn); }; },
    subscribeRoom(roomId: string, fn: () => void) { const entries = listeners.get(roomId) || new Set(); entries.add(fn); listeners.set(roomId, entries); return () => { entries.delete(fn); if (!entries.size) listeners.delete(roomId); }; },
  };
}

export const voiceSidebar = createVoiceSidebarStore(conferenceSnapshot, subscribeConference);
export const bindVoiceSidebar = voiceSidebar.bind;
