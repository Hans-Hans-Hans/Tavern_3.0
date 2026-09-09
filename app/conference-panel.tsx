import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Maximize2, Mic, MicOff, Minimize2, PhoneOff, Video, VideoOff } from 'lucide-react';
import type { ConferenceControls, ConferenceDevices } from '@/lib/conference';
import { MatrixRTCSessionEvent } from 'matrix-js-sdk/lib/matrixrtc/MatrixRTCSession';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { callSnapshot, callsConfigured } from '@/lib/calls';
import { conferenceSnapshot, subscribeConference, openConference, minimizeConference, conferenceJoined, conferenceFailed, conferenceClosing, clearConference } from '@/lib/conference-session';
import { requestPeerVerification } from '@/lib/security';
import { isManagedAccount, requestApi } from '@/lib/api';
import { canModerateMember } from '@/lib/channel-policy';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { ActionMenu, copyText } from './action-menu';
import './calls.css';

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

function useParticipants(roomId: string | null) {
  const [participants, setParticipants] = useState<{ userId: string; name: string; devices: number }[]>([]);
  useEffect(() => {
    if (!roomId) { setParticipants([]); return; }
    const client = getMatrixClient(), room = client?.getRoom(roomId);
    if (!client || !room) return;
    const session = client.matrixRTC.getRoomSession(room);
    const update = () => {
      const members = new Map<string, number>();
      for (const membership of session.memberships) members.set(membership.userId, (members.get(membership.userId) || 0) + 1);
      setParticipants([...members].map(([userId, devices]) => ({ userId, devices, name: room.getMember(userId)?.name || userId })));
    };
    update();
    session.on(MatrixRTCSessionEvent.MembershipsChanged, update);
    const off = onMatrixUpdate(update);
    return () => { session.off(MatrixRTCSessionEvent.MembershipsChanged, update); off(); };
  }, [roomId]);
  return participants;
}

/** Mounted once beside CallPanel, independently of the selected channel. */
export function ConferencePanel() {
  const session = useSyncExternalStore(subscribeConference, conferenceSnapshot);
  const frame = useRef<HTMLIFrameElement>(null), closeRef = useRef<(() => Promise<void>) | null>(null), epoch = useRef(0);
  const controlsRef = useRef<ConferenceControls | null>(null), [devices, setDevices] = useState<ConferenceDevices>({}), [deviceBusy, setDeviceBusy] = useState(false);
  const [moderation, setModeration] = useState(false), [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null), [moderationBusy, setModerationBusy] = useState(false);
  const participants = useParticipants(session.roomId);
  useEffect(() => {
    let alive = true; setModeration(false); setRemoving(null);
    if (session.roomId && isManagedAccount()) void requestApi('/calls/capabilities').then(value => { if (alive) setModeration(value.available === true); }).catch(() => {});
    return () => { alive = false; };
  }, [session.roomId]);
  useEffect(() => {
    if (!session.roomId || !frame.current) return;
    const generation = session.generation, roomId = session.roomId, currentEpoch = ++epoch.current;
    setDevices({}); setDeviceBusy(false); controlsRef.current = null;
    const client = getMatrixClient(), iframe = frame.current, controller = new AbortController();
    let disposed = false, stop: (() => Promise<void>) | null = null, closing = false;
    const close = async () => {
      if (closing || conferenceSnapshot().generation !== generation) return;
      closing = true; controller.abort(); conferenceClosing();
      try { const cleanup = stop; stop = null; await cleanup?.(); }
      finally { clearConference(generation); }
    };
    closeRef.current = close;
    if (!client) { clearConference(generation); return; }
    void import('@/lib/conference').then(module => module.mountConference(client, roomId, iframe, () => void close(), controller.signal, () => conferenceJoined(generation), true, value => { if (!disposed && !closing) setDevices(previous => ({ ...previous, ...value })); })).then(cleanup => {
      if (disposed || closing) void cleanup(); else { stop = cleanup; controlsRef.current = cleanup; }
    }).catch(error => { if (!disposed && !controller.signal.aborted) conferenceFailed(generation, error.message || 'The conference could not connect.'); });
    const off = onMatrixUpdate(() => { if (getMatrixClient() !== client || client.getRoom(roomId)?.getMyMembership() !== 'join') void close(); });
    return () => {
      disposed = true; controller.abort(); off();
      if (closeRef.current === close) closeRef.current = null;
      if (controlsRef.current === stop) controlsRef.current = null;
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
  async function changeDevices(patch: ConferenceDevices) { setDeviceBusy(true); try { await controlsRef.current?.setDevices(patch); } catch (error) { toast.error((error as Error).message); } finally { setDeviceBusy(false); } }
  async function removeParticipant() {
    if (!removing || !session.roomId) return;
    setModerationBusy(true);
    try {
      const result = await requestApi('/calls/remove', { roomId: session.roomId, userId: removing.userId, confirmation: 'REMOVE FROM CHANNEL AND CALL' });
      setRemoving(null);
      if (result.mediaDisconnectConfirmed) toast.success('Removed from the channel and conference.');
      else toast.warning(result.message || 'Channel membership was removed, but media disconnect could not be confirmed.', { duration: 12000 });
    } catch (error) { toast.error((error as Error).message); }
    finally { setModerationBusy(false); }
  }
  const client = getMatrixClient(), room = client?.getRoom(session.roomId), me = client?.getUserId();
  return <section className={'conference-panel persistent-conference' + (session.minimized ? ' conference-minimized' : '')} aria-label={'Conference in ' + (room?.name || 'conversation')}>
    <header><div><strong>{room?.name || 'Tavern conference'}</strong><small aria-live="polite">{session.phase === 'joining' ? 'Preparing your conference' : session.phase === 'joined' ? 'Conference active' : session.phase === 'closing' ? 'Leaving conference' : 'Connection needs attention'} · {participants.length} participating</small></div><div className="inline-actions">
      <button className="icon-button" disabled={deviceBusy || devices.audio_enabled === undefined || session.phase === 'closing'} aria-label={devices.audio_enabled ? 'Mute conference microphone' : 'Unmute conference microphone'} aria-pressed={devices.audio_enabled === false} onClick={() => void changeDevices({ audio_enabled: !devices.audio_enabled })}>{devices.audio_enabled ? <Mic/> : <MicOff/>}</button>
      <button className="icon-button" disabled={deviceBusy || devices.video_enabled === undefined || session.phase === 'closing'} aria-label={devices.video_enabled ? 'Disable conference camera' : 'Enable conference camera'} aria-pressed={devices.video_enabled} onClick={() => void changeDevices({ video_enabled: !devices.video_enabled })}>{devices.video_enabled ? <Video/> : <VideoOff/>}</button>
      <button className="icon-button" aria-label={session.minimized ? 'Expand conference' : 'Minimize conference'} title={session.minimized ? 'Expand conference' : 'Keep talking while browsing'} onClick={() => minimizeConference(!session.minimized)}>{session.minimized ? <Maximize2/> : <Minimize2/>}</button>
      <button disabled={session.phase === 'closing'} className="icon-button call-end" aria-label="Leave conference" onClick={() => void closeRef.current?.()}><PhoneOff/></button>
    </div></header>
    <div className="conference-content" aria-hidden={session.minimized}>
      {session.error && <div className="connect-error" role="alert"><p>{session.error}</p><button className="secondary-button" onClick={() => { try { openConference(session.roomId!); } catch (error) { toast.error((error as Error).message); } }}>Retry connection</button></div>}
      <div className="conference-participants" aria-label="Conference participants">{participants.map(member => <ActionMenu key={member.userId} actions={[
        { label: 'Copy user ID', run: () => copyText(member.userId) },
        { label: 'Verify participant identity', visible: member.userId !== me, run: () => requestPeerVerification(member.userId, session.roomId!) },
        { label: 'Remove from channel and call', danger: true, separator: true, visible: moderation && member.userId !== me && canModerateMember(session.roomId!, member.userId, 'kick'), run: () => setRemoving(member) },
      ]}><button title={member.userId + (member.devices > 1 ? ' · ' + member.devices + ' devices' : '')} className="conference-participant">{member.name}{member.userId === me ? ' (you)' : ''}</button></ActionMenu>)}</div>
      <iframe ref={frame} title="Tavern encrypted conference" allow="camera; microphone; display-capture; autoplay; fullscreen" referrerPolicy="no-referrer" tabIndex={session.minimized ? -1 : 0}/>
    </div>
    <AlertDialog open={!!removing} onOpenChange={open => { if (!open && !moderationBusy) setRemoving(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle><AlertDialogDescription>This removes their membership in this channel and disconnects their current conference devices. They will need channel access again to receive new encrypted conversations. This does not ban their account from the server.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={moderationBusy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={moderationBusy} onClick={event => { event.preventDefault(); void removeParticipant(); }}>{moderationBusy ? 'Removing…' : 'Remove from channel and call'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
