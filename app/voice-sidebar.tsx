import { memo, useCallback, useSyncExternalStore } from 'react';
import { Headphones, HeadphoneOff, Mic, MicOff, MonitorUp, PhoneOff, Settings2, Video } from 'lucide-react';
import { toast } from 'sonner';
import { getMatrixClient } from '@/lib/matrix';
import { voiceSidebar, type VoiceDockState } from '@/lib/voice-sidebar';
import { navigateParticipant } from '@/lib/participant-navigation';
import { useConferenceParticipants } from './voice-channel';
import { CommunityAvatar } from './community-settings';
import './voice-sidebar.css';

const VoiceParticipantRow = memo(function VoiceParticipantRow({ roomId, member }: { roomId: string; member: ReturnType<typeof useConferenceParticipants>[number] }) {
  const subscribe = useCallback((fn: () => void) => voiceSidebar.subscribeRoom(roomId, fn), [roomId]);
  const snapshot = useCallback(() => voiceSidebar.participant(roomId, member.userId, member.deviceIds), [roomId, member]);
  const state = useSyncExternalStore(subscribe, snapshot), local = member.userId === getMatrixClient()?.getUserId();
  const statuses = [state.speaking === true && 'Speaking', state.muted === true && 'Microphone muted', state.deafened === true && 'Deafened on this device', state.camera === true && 'Camera on', state.sharing === true && 'Sharing screen'].filter(Boolean);
  const unavailable = state.speaking === null && state.muted === null && state.camera === null && state.sharing === null;
  const label = member.name + (local ? ' (you)' : '') + (statuses.length ? ', ' + statuses.join(', ') : '') + (unavailable ? ', live device status unavailable' : '');
  return <li className={'voice-sidebar-member' + (state.speaking === true ? ' is-speaking' : '') + (local ? ' is-local' : '')}>
    <button type="button" aria-label={'View ' + label} title={label + (member.devices > 1 ? ' · ' + member.devices + ' devices' : '')}
      onClick={() => { try { navigateParticipant('profile', roomId, member.userId); } catch (error) { toast.error((error as Error).message); } }}>
      <span className="voice-sidebar-avatar"><CommunityAvatar roomId={roomId} userId={member.userId} size={24} fallback={member.name}/></span>
      <span className="voice-sidebar-member-name">{member.name}{local && <span className="voice-sidebar-you">you</span>}</span>
      <span className="voice-sidebar-member-icons" aria-hidden="true">{state.muted === true && <MicOff size={13}/>} {state.deafened === true && <HeadphoneOff size={13}/>} {state.camera === true && <Video size={13}/>} {state.sharing === true && <MonitorUp size={13}/>}</span>
    </button>
  </li>;
});

/** Native membership drives rows even when this device has no mounted call.
 * Only the active widget can supply speaking/device observations. */
export const VoiceSidebarParticipants = memo(function VoiceSidebarParticipants({ roomId }: { roomId: string }) {
  const members = useConferenceParticipants(roomId);
  if (!members.length) return null;
  return <ul className="voice-sidebar-participants" aria-label={'Voice participants in ' + (getMatrixClient()?.getRoom(roomId)?.name || 'channel')}>
    {members.map(member => <VoiceParticipantRow key={member.userId} roomId={roomId} member={member}/>)}</ul>;
});

export function VoiceSidebarDock({ onSelect, onSettings }: { onSelect: (roomId: string) => void; onSettings?: (roomId: string) => void }) {
  const state = useSyncExternalStore(voiceSidebar.subscribeDock, voiceSidebar.readDock);
  if (!state) return null;
  const room = getMatrixClient()?.getRoom(state.roomId);
  if (!room || room.getMyMembership() !== 'join') return null;
  const current = (expected: VoiceDockState) => voiceSidebar.readDock() === expected;
  async function run(action: () => unknown) { try { await action(); } catch (error) { if (voiceSidebar.owns(state!)) toast.error((error as Error).message); } }
  const label = { joining: 'Joining voice…', connected: 'Voice connected', reconnecting: 'Reconnecting voice…', closing: 'Leaving voice…', error: 'Voice needs attention', unknown: 'Checking voice connection…' }[state.phase];
  return <section className="voice-sidebar-dock" aria-label="Current voice call">
    <button type="button" className="voice-sidebar-current" aria-label={'Open voice channel ' + (room.name || 'Voice channel')} title="Open current voice channel" onClick={() => { if (current(state)) onSelect(state.roomId); }}>
      <Headphones size={17} aria-hidden="true"/><span><strong className={state.phase === 'connected' ? 'is-connected' : ''} role="status">{label}</strong><span>{room.name || 'Voice channel'}</span></span>
    </button>
    <div className="voice-sidebar-controls">
      <button type="button" disabled={!state.ready || state.microphone === null || state.busy || state.phase === 'closing' || state.deafened === true} aria-label={state.microphone === false ? 'Unmute voice microphone' : state.microphone === true ? 'Mute voice microphone' : 'Microphone status unavailable'} aria-pressed={state.microphone === null ? undefined : state.microphone === false} title={state.microphone === null ? 'Microphone status unavailable' : state.microphone ? 'Mute microphone' : 'Unmute microphone'}
        onClick={() => void run(() => voiceSidebar.microphone(state, !state.microphone))}>{state.microphone === false ? <MicOff size={18}/> : <Mic size={18}/>}</button>
      <button type="button" disabled={!state.ready || state.deafened === null || state.microphone === null || state.busy || state.phase === 'closing'} aria-label={state.deafened ? 'Undeafen voice' : 'Deafen voice'} aria-pressed={state.deafened ?? undefined} title={state.deafened ? 'Turn call sound back on. Your microphone stays muted.' : 'Mute your microphone and all incoming call audio'}
        onClick={() => void run(() => voiceSidebar.deafen(state, !state.deafened))}>{state.deafened ? <HeadphoneOff size={18}/> : <Headphones size={18}/>}</button>
      <button type="button" disabled={state.phase === 'closing'} aria-label="Voice settings and call controls" title="Call controls and audio devices"
        onClick={() => void run(() => { if (!current(state)) return; if (onSettings) onSettings(state.roomId); else return voiceSidebar.action(state, 'settings'); })}><Settings2 size={18}/></button>
      <button type="button" className="voice-sidebar-disconnect" disabled={state.phase === 'closing'} aria-label="Disconnect voice" title="Disconnect voice" onClick={() => void run(() => voiceSidebar.action(state, 'disconnect'))}><PhoneOff size={18}/></button>
    </div>
  </section>;
}
