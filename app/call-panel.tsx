import { useEffect, useRef, useState } from 'react';
import type { CallFeed } from 'matrix-js-sdk/lib/webrtc/callFeed';
import { CallState } from 'matrix-js-sdk/lib/webrtc/call';
import { Expand, Headphones, Maximize2, Mic, MicOff, Minimize2, Phone, PhoneOff, PictureInPicture2, ScreenShare, Settings2, Shrink, Video, VideoOff } from 'lucide-react';
import { toast } from 'sonner';
import { answerCall, callSnapshot, callsConfigured, endCall, startCall, subscribeCalls, toggleCall, watchFeed, setCallMediaSettings, setCallTalking, type CallMediaSettings } from '@/lib/calls';
import { getMatrixClient } from '@/lib/matrix';
import { requestPeerVerification } from '@/lib/security';
import { ActionMenu, copyText } from './action-menu';
import { navigateParticipant, onParticipantNavigation } from '@/lib/participant-navigation';
import { fullscreenAvailable, pictureInPictureAvailable, releaseVideoPresentation, toggleCallFullscreen, toggleCallPictureInPicture, watchSpeechActivity, type SpeechActivity } from '@/lib/call-presentation';
import { CallConnectionDetails } from './call-quality';
import './calls.css';

type OutputVideo = HTMLVideoElement & { setSinkId?: (deviceId: string) => Promise<void> };
type ParticipantPlayback = { muted: boolean; volume: number };
const defaultPlayback: ParticipantPlayback = { muted: false, volume: 1 };
function Feed({ feed, media, roomId, playback, setPlayback }: { feed: CallFeed; media: CallMediaSettings; roomId: string; playback: ParticipantPlayback; setPlayback: (patch: Partial<ParticipantPlayback>) => void }) {
  const ref = useRef<OutputVideo>(null), [playBlocked, setPlayBlocked] = useState(false), [, refresh] = useState(0);
  const [activity, setActivity] = useState<SpeechActivity>({ speaking: false, measured: false, level: 0 }), [pip, setPip] = useState(false);
  useEffect(() => watchSpeechActivity(feed, setActivity), [feed]);
  useEffect(() => {
    const element = ref.current; if (!element) return;
    const update = () => setPip(document.pictureInPictureElement === element);
    element.addEventListener('enterpictureinpicture', update); element.addEventListener('leavepictureinpicture', update);
    return () => { element.removeEventListener('enterpictureinpicture', update); element.removeEventListener('leavepictureinpicture', update); void releaseVideoPresentation(element); };
  }, [feed]);
  useEffect(() => {
    const element = ref.current;
    const update = () => { refresh(n => n + 1); if (element) { element.srcObject = feed.stream; void element.play().then(() => setPlayBlocked(false)).catch(() => setPlayBlocked(true)); } };
    update(); const off = watchFeed(feed, update);
    return () => { off(); if (element) element.srcObject = null; };
  }, [feed]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.volume = media.outputVolume * playback.volume;
    element.muted = feed.isLocal() || media.deafened || playback.muted;
    if (!feed.isLocal() && element.setSinkId) void element.setSinkId(media.audioOutput).catch(() => toast.error('The selected speaker is unavailable. Choose another output device.'));
  }, [feed, media.audioOutput, media.outputVolume, media.deafened, playback.muted, playback.volume]);
  const name = feed.isLocal() ? 'You' : getMatrixClient()?.getRoom(roomId)?.getMember(feed.userId)?.name || feed.userId;
  const speaking = activity.speaking && !feed.isAudioMuted(), hasVideo = !feed.isVideoMuted() && feed.stream.getVideoTracks().some(track => track.readyState === 'live');
  return <ActionMenu actions={[
    { label: 'View participant profile', run: () => navigateParticipant('profile', roomId, feed.userId) },
    { label: 'Message participant', visible: !feed.isLocal(), run: () => navigateParticipant('message', roomId, feed.userId) },
    { label: playback.muted ? 'Hear participant again' : 'Mute participant for me', visible: !feed.isLocal(), run: () => setPlayback({ muted: !playback.muted }) },
    { label: 'Verify participant identity', visible: !feed.isLocal(), run: () => requestPeerVerification(feed.userId, roomId) },
    { label: 'Copy user ID', run: () => copyText(feed.userId) },
  ]}><div className={'call-feed' + (speaking ? ' call-feed-speaking' : '')}><video ref={ref} autoPlay playsInline muted={feed.isLocal() || media.deafened || playback.muted}/><div className="call-feed-header"><button type="button" onClick={() => { try { navigateParticipant('profile', roomId, feed.userId); } catch (error) { toast.error((error as Error).message); } }}>{name}{feed.isAudioMuted() ? ' · Muted' : ''}{playback.muted ? ' · Muted for you' : ''}</button>{speaking && <span className='call-speaking' aria-label={name + ' is speaking'}>Speaking</span>}</div>
    {activity.measured && feed.hasAudioTrack && <div className='call-speech-meter' role='meter' aria-label={'Speech activity for ' + name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(activity.level)}><span style={{ width: activity.level + '%' }}/></div>}
    {(hasVideo || pip) && <div className='call-presentation-actions'><button className='secondary-button' disabled={!pictureInPictureAvailable(ref.current)} aria-label={pip ? 'Exit Picture-in-Picture for ' + name : 'Picture-in-Picture for ' + name} onClick={() => { if (ref.current) void toggleCallPictureInPicture(ref.current).catch(error => toast.error(error.message)); }}><PictureInPicture2 size={15}/>{pip ? 'Return video to Tavern' : 'Picture-in-Picture'}</button>{!pictureInPictureAvailable(ref.current) && <small>This browser does not offer video Picture-in-Picture.</small>}{pip && <small>Call controls remain in Tavern.</small>}</div>}
    {!feed.isLocal() && <details className="participant-playback"><summary>Participant volume</summary><label>{Math.round(playback.volume * 100)}%<input aria-label={'Volume for ' + name} className="call-volume" type="range" min="0" max="100" value={Math.round(playback.volume * 100)} onChange={event => setPlayback({ volume: Number(event.target.value) / 100 })}/></label><button className="secondary-button" aria-pressed={playback.muted} onClick={() => setPlayback({ muted: !playback.muted })}>{playback.muted ? 'Hear participant again' : 'Mute for me'}</button></details>}{playBlocked && <button className="secondary-button" onClick={() => void ref.current?.play().then(() => setPlayBlocked(false)).catch(() => toast.error('Audio playback is blocked. Check browser sound permissions.'))}>Enable audio</button>}</div></ActionMenu>;
}

function MicrophoneTest({ device }: { device: string }) {
  const [testing, setTesting] = useState(false), [level, setLevel] = useState(0), [busy, setBusy] = useState(false);
  const cleanup = useRef<(() => void) | null>(null), alive = useRef(true), attempt = useRef(0);
  const stop = () => { attempt.current++; cleanup.current?.(); cleanup.current = null; setTesting(false); setLevel(0); setBusy(false); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; attempt.current++; cleanup.current?.(); cleanup.current = null; }; }, []);
  useEffect(() => { stop(); }, [device]);
  async function start() {
    const current = ++attempt.current; setBusy(true);
    let stream: MediaStream | null = null, context: AudioContext | null = null, source: MediaStreamAudioSourceNode | null = null, timer = 0;
    const release = () => { cancelAnimationFrame(timer); source?.disconnect(); source = null; stream?.getTracks().forEach(track => track.stop()); stream = null; if (context && context.state !== 'closed') void context.close(); context = null; if (cleanup.current === release) cleanup.current = null; };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: device ? { deviceId: { exact: device } } : true, video: false });
      if (!alive.current || current !== attempt.current) { release(); return; }
      cleanup.current = release; context = new AudioContext(); const analyser = context.createAnalyser(); source = context.createMediaStreamSource(stream);
      analyser.fftSize = 512; source.connect(analyser); const values = new Uint8Array(analyser.fftSize);
      const sample = () => { analyser.getByteTimeDomainData(values); let sum = 0; for (const value of values) sum += ((value - 128) / 128) ** 2; setLevel(Math.min(100, Math.sqrt(sum / values.length) * 240)); timer = requestAnimationFrame(sample); };
      await context.resume(); if (!alive.current || current !== attempt.current) { release(); return; }
      setTesting(true); sample();
    } catch (error) { release(); if (alive.current && current === attempt.current) toast.error((error as Error).message || 'Microphone permission was not granted.'); }
    finally { if (alive.current && current === attempt.current) setBusy(false); }
  }
  return <div><button className="secondary-button" disabled={busy} onClick={() => testing ? stop() : void start()}>{testing ? 'Stop microphone test' : busy ? 'Requesting microphone' : 'Test microphone'}</button>{testing && <><p className="call-control-caption">This meter stays on your device. Testing does not unmute your call.</p><div className="call-mic-meter" role="meter" aria-label="Microphone input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level)}><span style={{ width: level + '%' }}/></div></>}</div>;
}

function DeviceSettings({ media, run }: { media: CallMediaSettings; run: (task: () => Promise<unknown>) => Promise<void> }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = () => { void navigator.mediaDevices?.enumerateDevices().then(value => { if (alive) setDevices(value); }).catch(() => { if (alive) toast.error('Audio/video devices could not be listed. Check browser permissions.'); }); };
    refresh(); navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => { alive = false; navigator.mediaDevices?.removeEventListener('devicechange', refresh); };
  }, []);
  function selector(kind: MediaDeviceKind, key: 'audioInput' | 'audioOutput' | 'videoInput', label: string) {
    return <label>{label}<select value={media[key]} onChange={event => void run(() => setCallMediaSettings({ [key]: event.target.value }))}><option value="">System default</option>{devices.filter(device => device.kind === kind && device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || label + ' ' + (index + 1)}</option>)}</select></label>;
  }
  const outputSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  return <div className="call-settings" aria-label="Call audio and video settings">
    {selector('audioinput', 'audioInput', 'Microphone')}{selector('videoinput', 'videoInput', 'Camera')}{outputSupported && selector('audiooutput', 'audioOutput', 'Speakers')}
    {!outputSupported && <p className="call-control-caption">This browser uses your system speaker selection.</p>}
    <label>Output volume · {Math.round(media.outputVolume * 100)}%<input className="call-volume" type="range" min="0" max="100" value={Math.round(media.outputVolume * 100)} onChange={event => void setCallMediaSettings({ outputVolume: Number(event.target.value) / 100 }).catch(error => toast.error(error.message))}/></label>
    <label className="call-check"><input type="checkbox" checked={media.pushToTalk} onChange={event => void run(() => setCallMediaSettings({ pushToTalk: event.target.checked }))}/>Push to talk</label>
    <label className="call-check"><input type="checkbox" checked={media.noiseSuppression} onChange={event => void run(() => setCallMediaSettings({ noiseSuppression: event.target.checked }))}/>Noise suppression</label>
    <label className="call-check"><input type="checkbox" checked={media.echoCancellation} onChange={event => void run(() => setCallMediaSettings({ echoCancellation: event.target.checked }))}/>Echo cancellation</label>
    <label className="call-check"><input type="checkbox" checked={media.autoGainControl} onChange={event => void run(() => setCallMediaSettings({ autoGainControl: event.target.checked }))}/>Automatic microphone gain</label>
    <MicrophoneTest device={media.audioInput}/>
  </div>;
}

export function CallButtons({ roomId, direct, disabled }: { roomId: string; direct: boolean; disabled: boolean }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => { let alive = true; void callsConfigured().then(value => { if (alive) setConfigured(value); }); return () => { alive = false; }; }, []);
  if (!direct) return null;
  return <><button className="icon-button" title={configured === false ? 'Your administrator needs to configure calls' : 'Start voice call'} aria-label="Start voice call" disabled={disabled || configured === false} onClick={() => void startCall(roomId, false).catch(error => toast.error(error.message))}><Phone size={18}/></button><button className="icon-button" title="Start video call" aria-label="Start video call" disabled={disabled || configured === false} onClick={() => void startCall(roomId, true).catch(error => toast.error(error.message))}><Video size={18}/></button></>;
}

export function CallPanel() {
  const [{ call, error, media }, setSnapshot] = useState(callSnapshot), [busy, setBusy] = useState(false), [settings, setSettings] = useState(false), [minimized, setMinimized] = useState(false), [talking, setTalking] = useState(false);
  const [participantPlayback, setParticipantPlayback] = useState<Record<string, ParticipantPlayback>>({});
  const panel = useRef<HTMLElement>(null), [fullscreen, setFullscreen] = useState(false), [canFullscreen, setCanFullscreen] = useState(false);
  useEffect(() => subscribeCalls(() => setSnapshot(callSnapshot())), []);
  useEffect(() => onParticipantNavigation(() => setMinimized(true)), []);
  useEffect(() => {
    const element = panel.current;
    const update = () => { setFullscreen(!!element && document.fullscreenElement === element); setCanFullscreen(fullscreenAvailable(element)); };
    update(); document.addEventListener('fullscreenchange', update);
    return () => { document.removeEventListener('fullscreenchange', update); if (element && document.fullscreenElement === element) void document.exitFullscreen().catch(() => {}); };
  }, [call]);
  useEffect(() => { if ((minimized || call?.state === CallState.Ended) && panel.current && document.fullscreenElement === panel.current) void document.exitFullscreen().catch(() => {}); }, [minimized, call?.state]);
  async function talk(value: boolean) { setTalking(value); try { await setCallTalking(value); } catch { setTalking(false); toast.error('The microphone state could not be changed.'); } }
  useEffect(() => {
    if (!call || !media.pushToTalk) { setTalking(false); return; }
    const release = () => void talk(false);
    const down = (event: KeyboardEvent) => { const element = event.target as HTMLElement | null; if (event.code !== 'Space' || event.repeat || event.ctrlKey || event.metaKey || event.altKey || element?.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(element?.tagName || '')) return; event.preventDefault(); void talk(true); };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') release(); };
    const visibility = () => { if (document.hidden) release(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', release); document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visibility); void setCallTalking(false); };
  }, [call, media.pushToTalk]);
  useEffect(() => { setMinimized(false); setSettings(false); setTalking(false); setParticipantPlayback({}); }, [call?.callId]);
  if (!call) return null;
  const incoming = call.state === CallState.Ringing, ended = call.state === CallState.Ended;
  const client = getMatrixClient(), room = client?.getRoom(call.roomId), peer = room?.getJoinedMembers().find(member => member.userId !== client?.getUserId());
  async function run(task: () => Promise<unknown>) { setBusy(true); try { await task(); } catch (error) { toast.error((error as Error).message); } finally { setBusy(false); } }
  return <section ref={panel} className={'call-panel' + (minimized ? ' call-minimized' : '')} aria-label="Active call"><header><div><strong>{room?.name || 'Direct call'}</strong><small>{incoming ? 'Incoming call' : ended ? 'Call ended' : call.state} · Relayed encrypted media</small></div><div className="call-header-actions"><button className='icon-button' disabled={!canFullscreen || ended} title={canFullscreen ? 'Show this call fullscreen' : 'Fullscreen is unavailable in this browser'} aria-label={fullscreen ? 'Exit call fullscreen' : 'Show call fullscreen'} onClick={() => { if (panel.current) { setMinimized(false); void run(() => toggleCallFullscreen(panel.current!)); } }}>{fullscreen ? <Shrink/> : <Expand/>}</button><button className="icon-button" onClick={() => setMinimized(value => !value)} aria-label={minimized ? 'Expand call' : 'Minimize call'}>{minimized ? <Maximize2/> : <Minimize2/>}</button><button className="icon-button call-end" onClick={endCall} aria-label={ended ? 'Close call' : 'End call'}><PhoneOff/></button></div></header>
    <div className="call-expanded">{incoming ? <div className="inline-actions"><button className="primary-button" disabled={busy} onClick={() => void run(() => answerCall(false))}>Answer with audio</button><button className="secondary-button" disabled={busy} onClick={() => void run(() => answerCall(true))}>Answer with video</button><button className="secondary-button" onClick={endCall}>Decline</button></div> : !ended && <><div className="call-feeds">{call.getFeeds().map(feed => <Feed key={feed.stream.id} feed={feed} media={media} roomId={call.roomId} playback={participantPlayback[feed.userId] || defaultPlayback} setPlayback={patch => setParticipantPlayback(previous => ({ ...previous, [feed.userId]: { ...(previous[feed.userId] || defaultPlayback), ...patch } }))}/>)}</div><div className="call-controls">
      <button disabled={busy || media.pushToTalk || media.deafened} aria-label={call.isMicrophoneMuted() ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={call.isMicrophoneMuted()} onClick={() => void run(() => toggleCall('mic'))}>{call.isMicrophoneMuted() ? <MicOff/> : <Mic/>}</button>
      <button disabled={busy} aria-label={call.isLocalVideoMuted() ? 'Enable camera' : 'Disable camera'} onClick={() => void run(() => toggleCall('camera'))}>{call.isLocalVideoMuted() ? <VideoOff/> : <Video/>}</button>
      <button disabled={busy} aria-label={call.isScreensharing() ? 'Stop sharing screen' : 'Share screen'} aria-pressed={call.isScreensharing()} onClick={() => void run(() => toggleCall('screen'))}><ScreenShare/></button>
      <button disabled={busy} aria-label={media.deafened ? 'Hear call again' : 'Deafen call and mute microphone'} aria-pressed={media.deafened} onClick={() => void run(() => setCallMediaSettings({ deafened: !media.deafened }))}><Headphones/></button>
      <button aria-label="Call device settings" aria-expanded={settings} onClick={() => setSettings(value => !value)}><Settings2/></button>
    </div>{media.pushToTalk && <><button className="secondary-button call-ptt" disabled={media.deafened} aria-pressed={talking} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); void talk(true); }} onPointerUp={() => void talk(false)} onPointerCancel={() => void talk(false)} onLostPointerCapture={() => void talk(false)} onKeyDown={event => { if ((event.code === 'Space' || event.code === 'Enter') && !event.repeat) { event.preventDefault(); void talk(true); } }} onKeyUp={event => { if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); void talk(false); } }} onBlur={() => void talk(false)}>{talking ? 'Talking' : 'Hold to talk'}</button><p className="call-control-caption">Hold Space while Tavern is focused, or hold this button. Release to mute.</p></>}</>}
    {settings && !ended && !minimized && <DeviceSettings media={media} run={run}/>}<div className="inline-actions">{peer && !ended && <button className="secondary-button" disabled={busy} onClick={() => void run(() => requestPeerVerification(peer.userId, call.roomId))}>Verify participant identity</button>}</div>{!incoming && !ended && <CallConnectionDetails call={call}/>}<p className='call-control-caption'>Video Picture-in-Picture and fullscreen depend on browser support. Speech indicators measure the existing call audio; no additional microphone is opened.</p>{error && <p className="connect-error" role="alert">{error}</p>}</div>
  </section>;
}
