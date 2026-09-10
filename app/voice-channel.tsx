import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Activity, Headphones, LockKeyhole, Mic, MicOff, ShieldAlert, Users } from 'lucide-react';
import { MatrixRTCSessionEvent } from 'matrix-js-sdk/lib/matrixrtc/MatrixRTCSession';
import { toast } from 'sonner';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { accountArtworkOwner } from '@/lib/api';
import { callsConfigured, callSnapshot } from '@/lib/calls';
import { conferenceSnapshot, subscribeConference, openConference, minimizeConference } from '@/lib/conference-session';
import { attachVoiceChannelView } from '@/lib/voice-channel-view';
import { readChannelPolicy } from '@/lib/channel-policy';
import type { ConferenceTelemetry } from '@/lib/conference-telemetry';
import { CommunityAvatar } from './community-settings';
import './voice-channel.css';

export function useConferenceParticipants(roomId: string | null) {
  type Participant = { userId: string; name: string; devices: number; deviceIds: string[] };
  const [observed, setObserved] = useState<{ current: () => boolean; participants: Participant[] } | null>(null);
  useEffect(() => {
    let detach = () => {}, bound: unknown, scope: unknown, stopped = false;
    const update = () => {
      if (stopped) return;
      const client = getMatrixClient(), owner = accountArtworkOwner();
      const room = roomId ? client?.getRoom(roomId) : undefined;
      if (!client || !room || room.getMyMembership() !== 'join') { detach(); bound = undefined; setObserved(null); return; }
      const actor = client.getUserId(), device = client.getDeviceId();
      const current = () => getMatrixClient() === client && accountArtworkOwner() === owner && client.getUserId() === actor && client.getDeviceId() === device && client.getRoom(roomId!) === room && room.getMyMembership() === 'join';
      const session = client.matrixRTC.getRoomSession(room);
      if (bound !== session || scope !== owner) {
        detach(); bound = session; scope = owner;
        session.on(MatrixRTCSessionEvent.MembershipsChanged, update);
        detach = () => session.off(MatrixRTCSessionEvent.MembershipsChanged, update);
      }
      const members = new Map<string, Set<string>>();
      for (const member of session.memberships.slice(0, 256)) {
        if (room.getMember(member.userId)?.membership !== 'join' || typeof member.deviceId !== 'string' || !member.deviceId || member.isExpired?.()) continue;
        const ids = members.get(member.userId) || new Set<string>(); ids.add(member.deviceId); members.set(member.userId, ids);
      }
      const next = [...members].slice(0, 128).map(([userId, ids]) => ({ userId, devices: ids.size, deviceIds: [...ids].sort(), name: room.getMember(userId)?.name || userId }));
      setObserved(previous => previous?.current() && JSON.stringify(previous.participants) === JSON.stringify(next) ? previous : { current, participants: next });
    };
    update(); const off = onMatrixUpdate(update);
    return () => { stopped = true; detach(); off(); };
  }, [roomId]);
  return observed?.current() ? observed.participants : [];
}

export function VoiceChannel({ roomId, name, disabled, onProfile }: { roomId: string; name: string; disabled?: boolean; onProfile: (id: string) => void }) {
  const root = useRef<HTMLDivElement>(null), session = useSyncExternalStore(subscribeConference, conferenceSnapshot);
  const participants = useConferenceParticipants(disabled ? null : roomId);
  const [busy, setBusy] = useState(false);
  const joinOwner = useRef<object | null>(null), joining = useRef(false);
  useEffect(() => {
    const identity = {}; joinOwner.current = identity; joining.current = false; setBusy(false);
    return () => { if (joinOwner.current === identity) { joinOwner.current = null; joining.current = false; } };
  }, [roomId, disabled]);
  useLayoutEffect(() => root.current ? attachVoiceChannelView(roomId, root.current) : undefined, [roomId]);
  useEffect(() => {
    if (conferenceSnapshot().roomId === roomId) minimizeConference(false);
    return () => { if (conferenceSnapshot().roomId === roomId) minimizeConference(true); };
  }, [roomId]);
  async function join() {
    if (disabled || joining.current || !joinOwner.current) return;
    const identity = joinOwner.current, client = getMatrixClient(), owner = accountArtworkOwner(), actor = client?.getUserId(), device = client?.getDeviceId(), room = client?.getRoom(roomId);
    const current = () => joinOwner.current === identity && getMatrixClient() === client && accountArtworkOwner() === owner && client?.getUserId() === actor && client?.getDeviceId() === device && client?.getRoom(roomId) === room;
    joining.current = true; setBusy(true);
    try {
      if (!await callsConfigured()) throw new Error('Voice calls are not configured. Ask your administrator to enable calls.');
      if (!current() || client?.getRoom(roomId)?.getMyMembership() !== 'join' || readChannelPolicy(roomId).kind !== 'voice') return;
      const direct = callSnapshot().call;
      if (direct && direct.state !== 'ended') throw new Error('Finish the direct call before joining this voice channel.');
      openConference(roomId);
    } catch (error) { if (current()) toast.error((error as Error).message); }
    finally { if (joinOwner.current === identity) { joining.current = false; setBusy(false); } }
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
  const encrypted = telemetry?.complete === true && telemetry.e2eeEnabled === true && peers.length > 0 && peers.every(peer => peer.encrypted === true && peer.e2eeEnabled === true);
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
