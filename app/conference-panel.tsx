import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Maximize2, Mic, MicOff, Minimize2, PhoneOff, Video, VideoOff } from 'lucide-react';
import type { ConferenceControls, ConferenceDevices } from '@/lib/conference';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { callSnapshot, callsConfigured } from '@/lib/calls';
import { conferenceSnapshot, subscribeConference, openConference, minimizeConference, conferenceJoined, conferenceFailed, conferenceClosing, clearConference } from '@/lib/conference-session';
import { requestPeerVerification } from '@/lib/security';
import { accountArtworkOwner, isManagedAccount, requestApi } from '@/lib/api';
import { canModerateMember, readChannelPolicy } from '@/lib/channel-policy';
import type { ConferenceTelemetry } from '@/lib/conference-telemetry';
import { voiceChannelView, subscribeVoiceChannelView } from '@/lib/voice-channel-view';
import { useConferenceParticipants, VoiceRoster } from './voice-channel';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { ActionMenu, copyText } from './action-menu';
import { navigateParticipant, onParticipantNavigation } from '@/lib/participant-navigation';
import { ConferenceIdle } from './conference-idle';
import { ConferenceAudioModeration, type AudioModerationTarget } from './conference-audio-moderation';
import { ConferenceAudioStatus } from './conference-audio-status';
import { ConferenceDiagnostics } from './conference-diagnostics';
import { bindVoiceSidebar } from '@/lib/voice-sidebar';
import './calls.css';

/** An async control belongs to the exact call and native account that started it. */
function operationOwner(roomId: string, generation: number) {
  const client = getMatrixClient(), account = accountArtworkOwner(), actor = client?.getUserId(), device = client?.getDeviceId(), room = client?.getRoom(roomId);
  return { roomId, generation, current: () => {
    const active = conferenceSnapshot();
    return !!client && !!actor && !!device && !!room && getMatrixClient() === client && accountArtworkOwner() === account &&
      client.getUserId() === actor && client.getDeviceId() === device && client.getRoom(roomId) === room && room.getMyMembership() === 'join' &&
      active.roomId === roomId && active.generation === generation && active.phase !== 'idle' && active.phase !== 'closing';
  } };
}
type RemovalTarget = { userId: string; name: string; owner: ReturnType<typeof operationOwner> };

export function ConferenceButton({ roomId, disabled }: { roomId: string; disabled: boolean }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => { let live = true; void callsConfigured().then(value => { if (live) setConfigured(value); }); return () => { live = false; }; }, []);
  async function join() {
    try {
      if (!await callsConfigured()) throw new Error('Calls are not configured. Ask your administrator to enable TURN and LiveKit.');
      const call = callSnapshot().call;
      if (call && call.state !== 'ended') throw new Error('Finish the direct call first.');
      openConference(roomId);
    } catch (error) { toast.error((error as Error).message); }
  }
  return <button className="icon-button" aria-label={configured === false ? 'Conference setup required' : 'Join conference'} title={configured === false ? 'Your administrator needs to configure calls' : 'Join conference'} disabled={disabled || configured === false} onClick={() => void join()}><Video size={18}/></button>;
}

/** Mounted once beside CallPanel, independently of the selected channel. */
export function ConferencePanel() {
  const session = useSyncExternalStore(subscribeConference, conferenceSnapshot);
  const voiceView = useSyncExternalStore(subscribeVoiceChannelView, voiceChannelView);
  const voiceOnly = !!session.roomId && readChannelPolicy(session.roomId).kind === 'voice';
  const [observation, setObservation] = useState<{roomId:string;generation:number;value:ConferenceTelemetry|null}|null>(null);
  const telemetry = observation?.roomId === session.roomId && observation.generation === session.generation ? observation.value : null;
  const [showTools, setShowTools] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null), closeRef = useRef<{ generation: number; roomId: string; close: () => Promise<boolean> } | null>(null), epoch = useRef(0);
  const controlsRef = useRef<{ controls: ConferenceControls; owner: ReturnType<typeof operationOwner> } | null>(null), deviceOperation = useRef<object | null>(null), [devices, setDevices] = useState<ConferenceDevices>({}), [deviceBusy, setDeviceBusy] = useState(false);
  const sidebarRef = useRef<ReturnType<typeof bindVoiceSidebar> | null>(null);
  const [moderation, setModeration] = useState(false), [removing, setRemoving] = useState<RemovalTarget | null>(null), [moderationBusy, setModerationBusy] = useState(false);
  const removalTarget = useRef<RemovalTarget | null>(null), removalOperation = useRef<object | null>(null);
  const [audioModeration, setAudioModeration] = useState(false), [audioTarget, setAudioTarget] = useState<AudioModerationTarget | null>(null);
  const participants = useConferenceParticipants(session.roomId);
  useEffect(() => { sidebarRef.current?.update({ busy: deviceBusy }); }, [deviceBusy]);
  useEffect(() => onParticipantNavigation(() => { if (conferenceSnapshot().roomId) minimizeConference(true); }), []);
  useEffect(() => {
    let alive = true; setModeration(false); setRemoving(null); setModerationBusy(false); removalTarget.current = null; removalOperation.current = null; setAudioModeration(false); setAudioTarget(null);
    const client = getMatrixClient(), account = accountArtworkOwner();
    if (session.roomId && isManagedAccount()) void requestApi('/calls/capabilities').then(value => {
      if (alive && getMatrixClient() === client && accountArtworkOwner() === account) {
        setModeration(value.available === true); setAudioModeration(value.audioModerationAvailable === true || value.audioModerationControls === true);
      }
    }).catch(() => {});
    return () => { alive = false; removalTarget.current = null; removalOperation.current = null; };
  }, [session.roomId, session.generation]);
  useEffect(() => {
    if (!session.roomId || !frame.current) return;
    const generation = session.generation, roomId = session.roomId, currentEpoch = ++epoch.current;
    setDevices({}); setDeviceBusy(false); setObservation(null); setShowTools(false); controlsRef.current = null; deviceOperation.current = null;
    const owner = operationOwner(roomId, generation);
    const client = getMatrixClient(), account = accountArtworkOwner(), iframe = frame.current, controller = new AbortController();
    let disposed = false, stop: (() => Promise<void>) | null = null, closing = false;
    const close = async () => {
      const active = conferenceSnapshot();
      if (closing || active.generation !== generation || active.roomId !== roomId || active.phase === 'idle') return false;
      closing = true; controller.abort(); conferenceClosing();
      try { const cleanup = stop; stop = null; await cleanup?.(); }
      finally { clearConference(generation); }
      const after = conferenceSnapshot();
      return after.generation === generation && after.roomId === null && after.phase === 'idle';
    };
    const scopedClose = { generation, roomId, close }; closeRef.current = scopedClose;
    if (!client) { clearConference(generation); return; }
    const sidebar = bindVoiceSidebar({ roomId, generation, isCurrent: () => !disposed && !closing && owner.current(), setMicrophone: enabled => changeDevices({ audio_enabled: enabled }), setDeafened: changeDeafened, disconnect: close,
      openSettings: () => { if (owner.current()) { setShowTools(true); minimizeConference(false); } } });
    sidebarRef.current = sidebar;
    void import('@/lib/conference').then(module => module.mountConference(client, roomId, iframe, () => void close(), controller.signal, () => conferenceJoined(generation), true, value => { if (!disposed && !closing && owner.current()) { setDevices(previous => ({ ...previous, ...value })); sidebar.update({ devices: value }); } }, {voiceOnly,onTelemetry:value=>{if(!disposed&&!closing&&getMatrixClient()===client&&accountArtworkOwner()===account){setObservation({roomId,generation,value});sidebar.update({telemetry:value});}}})).then(cleanup => {
      if (disposed || closing || !owner.current()) void cleanup(); else { stop = cleanup; controlsRef.current = { controls: cleanup, owner }; sidebar.update({ ready: true }); }
    }).catch(error => { if (!disposed && !controller.signal.aborted) conferenceFailed(generation, error.message || 'The conference could not connect.'); });
    const off = onMatrixUpdate(() => { if (!owner.current() || (readChannelPolicy(roomId).kind==='voice')!==voiceOnly) void close(); });
    return () => {
      disposed = true; controller.abort(); off();
      sidebar.dispose(); if (sidebarRef.current === sidebar) sidebarRef.current = null;
      if (closeRef.current === scopedClose) closeRef.current = null;
      if (controlsRef.current?.controls === stop) controlsRef.current = null;
      deviceOperation.current = null;
      const cleanup = stop; stop = null; void cleanup?.();
      queueMicrotask(() => { if (epoch.current === currentEpoch) clearConference(generation); });
    };
  }, [session.roomId, session.generation]);
  useEffect(() => {
    if (!session.roomId || session.minimized) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') minimizeConference(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [session.roomId, session.minimized]);
  if (!session.roomId) return null;
  async function changeDevices(patch: ConferenceDevices) {
    const admission = controlsRef.current;
    if (!admission?.owner.current() || deviceOperation.current) return;
    const operation = {}; deviceOperation.current = operation; setDeviceBusy(true);
    const current = () => deviceOperation.current === operation && controlsRef.current === admission && admission.owner.current();
    try { await admission.controls.setDevices(patch); }
    catch (error) { if (current()) toast.error((error as Error).message); }
    finally { if (current()) { deviceOperation.current = null; setDeviceBusy(false); } }
  }
  async function changeDeafened(deafened: boolean) {
    const admission = controlsRef.current;
    if (!admission?.owner.current() || deviceOperation.current) throw new Error('Voice audio controls are not ready for this call.');
    const operation = {}; deviceOperation.current = operation; setDeviceBusy(true);
    const current = () => deviceOperation.current === operation && controlsRef.current === admission && admission.owner.current();
    try {
      // Never restore microphone capture as a side effect of restoring playback.
      await admission.controls.setDevices({ audio_enabled: false });
      if (!current()) throw new Error('This voice call has ended.');
      await admission.controls.setDeafened(deafened);
    } finally { if (current()) { deviceOperation.current = null; setDeviceBusy(false); } }
  }
  function selectRemoval(member: { userId: string; name: string }) {
    const owner = operationOwner(session.roomId!, session.generation);
    if (!owner.current() || removalOperation.current) return;
    const target = { userId: member.userId, name: member.name, owner };
    removalTarget.current = target; setRemoving(target);
  }
  async function removeParticipant() {
    const target = removalTarget.current;
    if (!target || !target.owner.current() || removalOperation.current) return;
    const operation = {}; removalOperation.current = operation; setModerationBusy(true);
    const current = () => removalOperation.current === operation && removalTarget.current === target && target.owner.current();
    let completed = false;
    try {
      const result = await requestApi('/calls/remove', { roomId: target.owner.roomId, userId: target.userId, confirmation: 'REMOVE FROM CHANNEL AND CALL' });
      if (!current()) return;
      completed = true; setRemoving(null);
      if (result.mediaDisconnectConfirmed) toast.success('Removed from the channel and conference.');
      else toast.warning(result.message || 'Channel membership was removed, but media disconnect could not be confirmed.', { duration: 12000 });
    } catch (error) { if (current()) toast.error((error as Error).message); }
    finally { if (current()) { removalOperation.current = null; setModerationBusy(false); if (completed) removalTarget.current = null; } }
  }
  const visibleRemoval = removing?.owner.current() ? removing : null;
  const client = getMatrixClient(), room = client?.getRoom(session.roomId), me = client?.getUserId();
  const inline = voiceOnly && !session.minimized && voiceView?.roomId === session.roomId ? voiceView : null;
  const voiceReady = voiceOnly && telemetry?.connected === true && !telemetry.failure;
  return <section className={'conference-panel persistent-conference' + (session.minimized ? ' conference-minimized' : '') + (voiceOnly?' voice-conference':'') + (inline?' voice-inline':'')} style={inline?{left:inline.left,top:inline.top,width:inline.width,height:inline.height}:undefined} aria-label={'Conference in ' + (room?.name || 'conversation')}>
    <header><div><strong>{room?.name || 'Tavern conference'}</strong><small aria-live="polite">{telemetry?.failure ? 'Connection needs attention' : session.phase === 'joining' ? 'Preparing your conference' : session.phase === 'joined' ? 'Conference active' : session.phase === 'closing' ? 'Leaving conference' : 'Connection needs attention'} · {participants.length} participating</small></div><div className="inline-actions">
      <button className="icon-button" disabled={deviceBusy || devices.audio_enabled === undefined || session.phase === 'closing' || telemetry?.deafened === true} aria-label={devices.audio_enabled ? 'Mute conference microphone' : 'Unmute conference microphone'} aria-pressed={devices.audio_enabled === false} onClick={() => void changeDevices({ audio_enabled: !devices.audio_enabled })}>{devices.audio_enabled ? <Mic/> : <MicOff/>}</button>
      {!voiceOnly&&<button className="icon-button" disabled={deviceBusy || devices.video_enabled === undefined || session.phase === 'closing'} aria-label={devices.video_enabled ? 'Disable conference camera' : 'Enable conference camera'} aria-pressed={devices.video_enabled} onClick={() => void changeDevices({ video_enabled: !devices.video_enabled })}>{devices.video_enabled ? <Video/> : <VideoOff/>}</button>}
      <button className="icon-button" aria-label={session.minimized ? 'Expand conference' : 'Minimize conference'} title={session.minimized ? 'Expand conference' : 'Keep talking while browsing'} onClick={() => minimizeConference(!session.minimized)}>{session.minimized ? <Maximize2/> : <Minimize2/>}</button>
      <button disabled={session.phase === 'closing'} className="icon-button call-end" aria-label="Leave conference" onClick={() => void closeRef.current?.close()}><PhoneOff/></button>
    </div></header>
    {audioModeration && <ConferenceAudioStatus key={session.roomId + ':' + session.generation} roomId={session.roomId} generation={session.generation}/>}
    <ConferenceIdle roomId={session.roomId} generation={session.generation} joined={session.phase === 'joined'} frame={frame} onLeave={closeRef.current?.generation === session.generation && closeRef.current.roomId === session.roomId ? closeRef.current.close : null}/>
    <div className="conference-content" aria-hidden={session.minimized}>
      <ConferenceDiagnostics failure={telemetry?.failure}/>
      {session.error && <div className="connect-error" role="alert"><p>{session.error}</p><button className="secondary-button" onClick={() => { try { openConference(session.roomId!); } catch (error) { toast.error((error as Error).message); } }}>Retry connection</button></div>}
      <div className="conference-participants" aria-label="Conference participants">{participants.map(member => <ActionMenu key={member.userId} actions={[
        { label: 'View participant profile', run: () => navigateParticipant('profile', session.roomId!, member.userId) },
        { label: 'Message participant', visible: member.userId !== me, run: () => navigateParticipant('message', session.roomId!, member.userId) },
        { label: 'Copy user ID', run: () => copyText(member.userId) },
        { label: 'Verify participant identity', visible: member.userId !== me, run: () => requestPeerVerification(member.userId, session.roomId!) },
        { label: 'Server mute…', visible: audioModeration && member.userId !== me, run: () => setAudioTarget({ ...member, action: 'muted' }) },
        { label: 'Server deafen…', visible: audioModeration && member.userId !== me, run: () => setAudioTarget({ ...member, action: 'deafened' }) },
        { label: 'Remove from channel and call', danger: true, separator: true, visible: moderation && member.userId !== me && canModerateMember(session.roomId!, member.userId, 'kick'), run: () => selectRemoval(member) },
      ]}><button onClick={() => { try { navigateParticipant('profile', session.roomId!, member.userId); } catch (error) { toast.error((error as Error).message); } }} title={member.userId + (member.devices > 1 ? ' · ' + member.devices + ' devices' : '')} className="conference-participant">{member.name}{member.userId === me ? ' (you)' : ''}</button></ActionMenu>)}</div>
      {voiceReady&&!showTools&&<VoiceRoster roomId={session.roomId} telemetry={telemetry} onProfile={id=>{try{navigateParticipant('profile',session.roomId!,id);}catch(error){toast.error((error as Error).message);}}}/>}
      <iframe ref={frame} className={voiceReady&&!showTools?'voice-frame-hidden':undefined} aria-hidden={session.minimized||voiceReady&&!showTools} title="Tavern encrypted conference" allow={voiceOnly?"camera 'none'; display-capture 'none'; microphone; autoplay; fullscreen":"camera; microphone; display-capture; autoplay; fullscreen"} referrerPolicy="no-referrer" tabIndex={session.minimized||voiceReady&&!showTools ? -1 : 0}/>
      {voiceReady&&<div className="voice-call-tools"><button className="secondary-button" onClick={()=>setShowTools(value=>!value)}>{showTools?'Show voice participants':'Call controls and devices'}</button></div>}
    </div>
    {audioTarget && <ConferenceAudioModeration key={session.roomId + ':' + session.generation + ':' + audioTarget.userId + ':' + audioTarget.action} roomId={session.roomId} generation={session.generation} target={audioTarget} onClose={() => setAudioTarget(null)}/>}
    <AlertDialog open={!!visibleRemoval} onOpenChange={open => { if (!open && !moderationBusy) { removalTarget.current = null; setRemoving(null); } }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove {visibleRemoval?.name}?</AlertDialogTitle><AlertDialogDescription>This removes their membership in this channel and disconnects their current conference devices. They will need channel access again to receive new encrypted conversations. This does not ban their account from the server.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={moderationBusy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={moderationBusy} onClick={event => { event.preventDefault(); void removeParticipant(); }}>{moderationBusy ? 'Removing…' : 'Remove from channel and call'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
