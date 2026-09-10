import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Activity, Headphones, LockKeyhole, Mic, MicOff, ShieldAlert, Users } from 'lucide-react';
import { MatrixRTCSessionEvent } from 'matrix-js-sdk/lib/matrixrtc/MatrixRTCSession';
import { toast } from 'sonner';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { accountArtworkOwner } from '@/lib/api';
import { callsConfigured, callSnapshot } from '@/lib/calls';
import { conferenceSnapshot, subscribeConference, openConference, minimizeConference } from '@/lib/conference-session';
import { attachVoiceChannelView } from '@/lib/voice-channel-view';
import type { ConferenceTelemetry } from '@/lib/conference-telemetry';
import { CommunityAvatar } from './community-settings';
import './voice-channel.css';

export function useConferenceParticipants(roomId: string | null) {
  const [participants, setParticipants] = useState<{ userId: string; name: string; devices: number }[]>([]);
  useEffect(() => {
    let detach = () => {}, bound: unknown, scope: unknown, stopped = false;
    const update = () => {
      if (stopped) return;
      const client = getMatrixClient(), owner = accountArtworkOwner();
      const room = roomId ? client?.getRoom(roomId) : undefined;
      if (!client || !room || room.getMyMembership() !== 'join') { detach(); bound = undefined; setParticipants([]); return; }
      const session = client.matrixRTC.getRoomSession(room);
      if (bound !== session || scope !== owner) {
        detach(); bound = session; scope = owner;
        session.on(MatrixRTCSessionEvent.MembershipsChanged, update);
        detach = () => session.off(MatrixRTCSessionEvent.MembershipsChanged, update);
      }
      const members = new Map<string, number>();
      for (const member of session.memberships.slice(0, 256)) {
        if (room.getMember(member.userId)?.membership !== 'join') continue;
        members.set(member.userId, (members.get(member.userId) || 0) + 1);
      }
      const next = [...members].slice(0, 128).map(([userId, devices]) => ({ userId, devices, name: room.getMember(userId)?.name || userId }));
      setParticipants(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    update(); const off = onMatrixUpdate(update);
    return () => { stopped = true; detach(); off(); };
  }, [roomId]);
  return participants;
}

export function VoiceChannel({ roomId, name, disabled, onProfile }: { roomId: string; name: string; disabled?: boolean; onProfile: (id: string) => void }) {
  const root = useRef<HTMLDivElement>(null), session = useSyncExternalStore(subscribeConference, conferenceSnapshot);
  const participants = useConferenceParticipants(disabled ? null : roomId);
  const [busy, setBusy] = useState(false);
  useLayoutEffect(() => root.current ? attachVoiceChannelView(roomId, root.current) : undefined, [roomId]);
  useEffect(() => {
    if (conferenceSnapshot().roomId === roomId) minimizeConference(false);
    return () => { if (conferenceSnapshot().roomId === roomId) minimizeConference(true); };
  }, [roomId]);
  async function join() {
    const client = getMatrixClient(), owner = accountArtworkOwner(); setBusy(true);
    try {
      if (!await callsConfigured()) throw new Error('Voice calls are not configured. Ask your administrator to enable calls.');
      if (getMatrixClient() !== client || accountArtworkOwner() !== owner || client?.getRoom(roomId)?.getMyMembership() !== 'join') return;
      const direct = callSnapshot().call;
      if (direct && direct.state !== 'ended') throw new Error('Finish the direct call before joining this voice channel.');
      openConference(roomId);
    } catch (error) { if (getMatrixClient() === client && accountArtworkOwner() === owner) toast.error((error as Error).message); }
    finally { setBusy(false); }
  }
  return <div ref={root} className="voice-channel" aria-label={'Voice channel ' + name}>
    <div className="voice-channel-welcome"><span className="voice-channel-symbol"><Headphones size={32}/></span><h2>{name}</h2><p>A place to talk. Join with your microphone; your camera stays off.</p>
      <button className="primary-button" disabled={disabled || busy} onClick={() => void join()}><Headphones size={18}/>{busy ? 'Checking voice access…' : session.roomId === roomId ? 'Return to voice' : 'Join voice'}</button>
      <small><LockKeyhole size={14}/>Voice uses the encrypted conference service.</small>
    </div>
    <div className="voice-channel-presence"><h3><Users size={17}/>In this channel <span>{participants.length}</span></h3>
      {participants.length ? <div className="voice-avatar-grid">{participants.map(member => <button className="voice-person" key={member.userId} onClick={() => onProfile(member.userId)}><CommunityAvatar roomId={roomId} userId={member.userId} size={64} fallback={member.name}/><strong>{member.name}</strong>{member.devices > 1 && <small>{member.devices} devices</small>}</button>)}</div> : <p className="voice-empty">No one is here yet. Join and invite someone to talk.</p>}
    </div>
  </div>;
}

export function VoiceRoster({ roomId, telemetry, onProfile }: { roomId: string; telemetry: ConferenceTelemetry | null; onProfile: (userId: string) => void }) {
  const peers = telemetry?.participants || [];
  const encrypted = telemetry?.e2eeEnabled === true && peers.every(peer => peer.encrypted !== false && peer.e2eeEnabled !== false);
  const unencrypted = telemetry?.e2eeEnabled === false || peers.some(peer => peer.encrypted === false || peer.e2eeEnabled === false);
  const metrics = telemetry?.metrics;
  return <div className="voice-connected" aria-label="Connected voice participants">
    <div className="voice-connection-status" role="status"><span><Activity size={16}/>{telemetry?.connected ? 'Voice connected' : telemetry?.reconnecting ? 'Reconnecting voice…' : 'Waiting for connection status…'}</span><span title="Measured media round-trip time to the call server">Ping: {metrics?.rttMs == null ? 'Measuring…' : Math.round(metrics.rttMs) + ' ms'}</span></div>
    <div className="voice-avatar-grid">{peers.map(peer => <button key={peer.identity} className={'voice-person' + (peer.speaking ? ' voice-speaking' : '')} onClick={() => onProfile(peer.userId)} aria-label={'View ' + peer.displayName + ' profile' + (peer.speaking ? ', speaking' : '')}>
      <span className="voice-avatar-ring"><CommunityAvatar roomId={roomId} userId={peer.userId} size={76} fallback={peer.displayName}/></span><strong>{peer.displayName}{peer.local ? ' (you)' : ''}</strong><small>{peer.microphoneEnabled ? <Mic size={14}/> : <MicOff size={14}/>} {peer.speaking ? 'Speaking' : peer.microphoneEnabled ? 'Listening' : 'Microphone muted'}</small>
    </button>)}</div>
    {!peers.length && <p className="voice-empty">Participant details will appear when the call connects.</p>}
    {telemetry?.complete === false && <p className="voice-empty">Showing the first 128 participants.</p>}
    <div className={'voice-encryption' + (unencrypted ? ' voice-encryption-warning' : '')}>{unencrypted ? <ShieldAlert size={17}/> : <LockKeyhole size={17}/>}<span>{unencrypted ? 'Encryption needs attention. Leave and rejoin the call.' : encrypted ? 'End-to-end encryption enabled' : 'Checking voice encryption…'}</span></div>
    <details className="voice-network-details"><summary>Connection details</summary><dl><div><dt>Jitter</dt><dd>{metrics?.jitterMs == null ? 'Unavailable' : metrics.jitterMs.toFixed(1) + ' ms'}</dd></div><div><dt>Packet loss</dt><dd>{metrics?.packetLossPercent == null ? 'Unavailable' : metrics.packetLossPercent.toFixed(1) + '%'}</dd></div><div><dt>Media samples</dt><dd>{metrics ? metrics.sampledTracks + ' of ' + metrics.totalTracks : 'Unavailable'}</dd></div></dl><small>Live measurements from this device. Missing samples are shown as unavailable.</small></details>
  </div>;
}
