import { claimMedia, releaseMedia } from './media-session';

export type ConferenceState = { roomId: string | null; minimized: boolean; phase: 'idle' | 'joining' | 'joined' | 'closing' | 'error'; error: string; generation: number };
let state: ConferenceState = { roomId: null, minimized: false, phase: 'idle', error: '', generation: 0 };
const listeners = new Set<() => void>();
const change = (next: Partial<ConferenceState>) => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };
export const conferenceSnapshot = () => state;
export function subscribeConference(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function openConference(roomId: string) {
  if (!roomId) throw new Error('Choose a conversation first.');
  if (state.roomId && state.roomId !== roomId) throw new Error('Leave your current conference before joining another room.');
  if (state.roomId && state.phase !== 'error') { change({ minimized: false }); return; }
  claimMedia('conference');
  change({ roomId, minimized: false, phase: 'joining', error: '', generation: state.generation + 1 });
}
export const minimizeConference = (minimized = true) => change({ minimized });
export function conferenceJoined(generation: number) { if (generation === state.generation && state.phase === 'joining') change({ phase: 'joined' }); }
export function conferenceFailed(generation: number, message: string) { if (generation === state.generation) { releaseMedia('conference'); change({ phase: 'error', error: message }); } }
export const conferenceClosing = () => change({ phase: 'closing' });
export function clearConference(generation: number) {
  if (generation !== state.generation) return;
  releaseMedia('conference');
  change({ roomId: null, phase: 'idle', error: '', minimized: false });
}
