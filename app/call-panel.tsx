import { useEffect, useRef, useState } from 'react';
import type { CallFeed } from 'matrix-js-sdk/lib/webrtc/callFeed';
import { CallState } from 'matrix-js-sdk/lib/webrtc/call';
import { Mic, MicOff, Phone, PhoneOff, ScreenShare, Video, VideoOff } from 'lucide-react';
import { toast } from 'sonner';
import { answerCall, callSnapshot, endCall, startCall, subscribeCalls, toggleCall, watchFeed } from '@/lib/calls';
import { getMatrixClient } from '@/lib/matrix';
import { requestPeerVerification } from '@/lib/security';
function Feed({ feed }: { feed: CallFeed }) {
  const ref = useRef<HTMLVideoElement>(null), [playBlocked, setPlayBlocked] = useState(false), [, refresh] = useState(0);
  useEffect(() => { const update = () => { refresh(n => n + 1); if (ref.current) { ref.current.srcObject = feed.stream; void ref.current.play().catch(() => setPlayBlocked(true)); } }; update(); const off = watchFeed(feed, update); return () => { off(); if (ref.current) ref.current.srcObject = null; }; }, [feed]);
  return <div className="call-feed"><video ref={ref} autoPlay playsInline muted={feed.isLocal()} /><span>{feed.isLocal() ? 'You' : feed.userId}{feed.isAudioMuted() ? ' · Muted' : ''}</span>{playBlocked && <button onClick={() => void ref.current?.play().then(() => setPlayBlocked(false)).catch(e => toast.error(e.message))}>Enable audio</button>}</div>;
}
export function CallButtons({ roomId, direct, disabled }: { roomId: string; direct: boolean; disabled: boolean }) {
  if (!direct) return null;
  return <><button className="icon-button" title="Start voice call" aria-label="Start voice call" disabled={disabled} onClick={() => void startCall(roomId, false).catch(e => toast.error(e.message))}><Phone size={18}/></button><button className="icon-button" title="Start video call" aria-label="Start video call" disabled={disabled} onClick={() => void startCall(roomId, true).catch(e => toast.error(e.message))}><Video size={18}/></button></>;
}
export function CallPanel() {
  const [{ call, error }, setSnapshot] = useState(callSnapshot), [busy, setBusy] = useState(false);
  useEffect(() => subscribeCalls(() => setSnapshot(callSnapshot())), []);
  if (!call) return null;
  const incoming = call.state === CallState.Ringing, ended = call.state === CallState.Ended;
  const c = getMatrixClient(), room = c?.getRoom(call.roomId), peer = room?.getJoinedMembers().find(m => m.userId !== c?.getUserId());
  async function run(task: () => Promise<unknown>) { setBusy(true); try { await task(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  return <section className="call-panel" aria-label="Active call"><header><div><strong>{room?.name || 'Direct call'}</strong><small>{incoming ? 'Incoming call' : ended ? 'Call ended' : call.state} · Relayed encrypted media</small></div><button className="icon-button" onClick={endCall} aria-label={ended ? 'Close call' : 'End call'}><PhoneOff /></button></header>
    {incoming ? <div className="inline-actions"><button className="primary-button" disabled={busy} onClick={() => void run(() => answerCall(false))}>Answer with audio</button><button className="secondary-button" disabled={busy} onClick={() => void run(() => answerCall(true))}>Answer with video</button><button className="secondary-button" onClick={endCall}>Decline</button></div> : !ended && <><div className="call-feeds">{call.getFeeds().map(feed => <Feed key={`${feed.userId}|${feed.deviceId}|${feed.purpose}`} feed={feed}/>)}</div><div className="call-controls"><button disabled={busy} aria-label="Toggle microphone" title={call.isMicrophoneMuted() ? 'Unmute' : 'Mute'} onClick={() => void run(() => toggleCall('mic'))}>{call.isMicrophoneMuted() ? <MicOff /> : <Mic />}</button><button disabled={busy} aria-label="Toggle camera" onClick={() => void run(() => toggleCall('camera'))}>{call.isLocalVideoMuted() ? <VideoOff /> : <Video />}</button><button disabled={busy} aria-label={call.isScreensharing() ? 'Stop sharing screen' : 'Share screen'} aria-pressed={call.isScreensharing()} onClick={() => void run(() => toggleCall('screen'))}><ScreenShare /></button></div></>}
    {peer && !ended && <button className="secondary-button" disabled={busy} onClick={() => void run(() => requestPeerVerification(peer.userId, call.roomId))}>Verify participant identity</button>}{error && <p className="connect-error" role="alert">{error}</p>}
  </section>;
}
