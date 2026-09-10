import { claimMedia, releaseMedia, mediaOwner } from './media-session';
import { CallEvent, CallFeedEvent, ClientEvent, type MatrixClient, type MatrixCall } from 'matrix-js-sdk';
import { CallFeed } from 'matrix-js-sdk/lib/webrtc/callFeed';
import { SDPStreamMetadataPurpose } from 'matrix-js-sdk/lib/webrtc/callEventTypes';
import { readInstanceConfig } from './instance';
import { CallEventHandlerEvent } from 'matrix-js-sdk/lib/webrtc/callEventHandler';
import { CallErrorCode, CallState } from 'matrix-js-sdk/lib/webrtc/call';
import { accountArtworkOwner } from './api';
import { callRelayError, callCancelledError, currentCallRelay, refreshCallRelay, configureInitialCallRelay } from './call-relay';
let client: MatrixClient | null = null;
let active: MatrixCall | null = null;
let error = '';
let busy = false;
let mediaEpoch = 0;
export type CallMediaSettings = { audioInput: string; videoInput: string; audioOutput: string; outputVolume: number; noiseSuppression: boolean; echoCancellation: boolean; autoGainControl: boolean; deafened: boolean; pushToTalk: boolean };
let media: CallMediaSettings = { audioInput: '', videoInput: '', audioOutput: '', outputVolume: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true, deafened: false, pushToTalk: false };
try { const saved = JSON.parse(localStorage.getItem('tavern.call-devices') || '{}'); for (const key of ['audioInput', 'videoInput', 'audioOutput'] as const) if (typeof saved[key] === 'string' && saved[key].length < 512) media[key] = saved[key]; } catch { /* Device preferences are optional. */ }
let configured: Promise<boolean> | null = null;
export function callsConfigured() { return configured ||= readInstanceConfig().then(value => value.callsEnabled !== false); }
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(fn => fn());
let detach: (() => void) | null = null;
let detachRelay: (() => void) | null = null;
function identityOwner(c: MatrixClient) {
  const account = accountArtworkOwner(), actor = c.getUserId(), device = c.getDeviceId(), base = c.getHomeserverUrl();
  return () => client === c && accountArtworkOwner() === account && c.getUserId() === actor && c.getDeviceId() === device && c.getHomeserverUrl() === base;
}
function callOwner(c: MatrixClient, roomId: string) {
  const identity = identityOwner(c), room = c.getRoom(roomId), epoch = mediaEpoch;
  return () => identity() && epoch === mediaEpoch && !!room && c.getRoom(roomId) === room && room.getMyMembership() === 'join' && room.hasEncryptionStateEvent() && room.getJoinedMemberCount() === 2;
}
const hasEnded = (call: MatrixCall) => call.state === CallState.Ended;
export function subscribeCalls(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function callSnapshot() { return { call: active, error, busy, media, client }; }
function attach(call: MatrixCall) {
  claimMedia('direct',true);detach?.(); active = call; error = '';
  const failure = (e: Error) => { error = e.message; changed(); };
  const replaced = (next: MatrixCall) => attach(next);
  const ended=()=>{if(active===call)releaseMedia('direct');changed();};
  call.on(CallEvent.State, changed); call.on(CallEvent.FeedsChanged, changed); call.on(CallEvent.Hangup, ended);
  call.on(CallEvent.Error, failure); call.on(CallEvent.Replaced, replaced);
  detach = () => { call.off(CallEvent.State, changed); call.off(CallEvent.FeedsChanged, changed); call.off(CallEvent.Hangup, ended); call.off(CallEvent.Error, failure); call.off(CallEvent.Replaced, replaced); };
  changed();
}
function incoming(call: MatrixCall) {
  if (call.groupCallId || hasEnded(call)) return;
  const sender = call.getOpponentMember()?.userId;
  if (sender && client?.getIgnoredUsers().includes(sender)) { call.reject(); return; }
  const room = client?.getRoom(call.roomId);
  if (!room || room.getMyMembership() !== 'join' || !room.hasEncryptionStateEvent() || room.getJoinedMemberCount() !== 2 || busy || (active && active.state !== CallState.Ended) || mediaOwner()==='conference') { call.reject(); return; }
  attach(call);
}
export function initializeCalls(c: MatrixClient) {
  resetCalls(); client = c; c.getMediaHandler().restoreMediaSettings(media.audioInput, media.videoInput); c.on(CallEventHandlerEvent.Incoming, incoming);
  const identity = identityOwner(c); let refreshFailed = false;
  const available = () => { refreshFailed = false; }, unavailable = () => { refreshFailed = true; };
  const peerCreated = (peer: RTCPeerConnection, call: MatrixCall) => {
    // SDK emits synchronously before setting remote SDP / creating an offer,
    // including calls accepted automatically during a glare replacement.
    if (!identity() || call.groupCallId || call.peerConn !== peer || hasEnded(call) || peer.localDescription ||
        !['stable', 'have-remote-offer'].includes(peer.signalingState) || ['connected', 'disconnected', 'failed', 'closed'].includes(peer.connectionState)) return;
    try {
      if (refreshFailed) throw new Error(callRelayError);
      configureInitialCallRelay(peer, currentCallRelay(c), callOwner(c, call.roomId));
    } catch {
      // An SDK event listener must not throw into its call setup pipeline.
      try { peer.close(); } catch { /* already closed */ }
      try { call.hangup(CallErrorCode.UserHangup, false); } catch { /* exact failed call only */ }
      if (active === call) { error = callRelayError; changed(); }
    }
  };
  c.on(ClientEvent.TurnServers, available); c.on(ClientEvent.TurnServersError, unavailable); c.on(CallEvent.PeerConnectionCreated, peerCreated);
  detachRelay = () => { c.off(ClientEvent.TurnServers, available); c.off(ClientEvent.TurnServersError, unavailable); c.off(CallEvent.PeerConnectionCreated, peerCreated); };
}
export function resetCalls() { mediaEpoch++; detachRelay?.(); detachRelay = null; if (active && active.state !== CallState.Ended) active.hangup(CallErrorCode.UserHangup, false); detach?.(); detach = null; client?.off(CallEventHandlerEvent.Incoming, incoming); client = null; active = null;releaseMedia('direct'); busy = false; error = ''; changed(); }
async function requireRelay(roomId: string) {
  const current = client;
  if (!current) throw new Error('Sign in before starting a call.');
  const owned = callOwner(current, roomId);
  if (!await callsConfigured()) throw new Error('Your administrator must enable calls and configure TURN before you can connect.');
  if (!owned()) throw new Error(callCancelledError);
  const servers = await refreshCallRelay(current, owned);
  return { current, owned, servers };
}
export async function startCall(roomId: string, video: boolean) {
  if (busy || (active && active.state !== CallState.Ended) || mediaOwner()==='conference') throw new Error('Finish the current call first.');
  claimMedia('direct'); const epoch = ++mediaEpoch; let started: MatrixCall | null = null; busy = true; changed();
  try {
    const { current, owned } = await requireRelay(roomId);
    if (epoch !== mediaEpoch) throw new Error('The call was canceled.');
    const room = current.getRoom(roomId);
    if (!room?.hasEncryptionStateEvent() || room.getMyMembership() !== 'join') throw new Error('Calls require a joined encrypted conversation.');
    if (room.getJoinedMemberCount() !== 2) throw new Error('Use the conference button for group calls. Direct calls require exactly two joined members.');
    const call = current.createCall(roomId); if (!call) throw new Error('WebRTC is not available in this browser.'); started = call; attach(call);
    if (media.pushToTalk || media.deafened) {
      const feed = await mutedFeed(current, roomId, video);
      if (!owned() || epoch !== mediaEpoch || active !== call || call.state === CallState.Ended) { current.getMediaHandler().stopUserMediaStream(feed.stream); throw new Error('The call was canceled.'); }
      await call.placeCallWithCallFeeds([feed]);
    }
    else if (video) await call.placeVideoCall(); else await call.placeVoiceCall();
  } catch (e) { if (epoch === mediaEpoch) { error = (e as Error).message; if (started && started.state !== CallState.Ended) started.hangup(CallErrorCode.UserHangup, false); releaseMedia('direct'); } throw e; }
  finally { if (epoch === mediaEpoch) { busy = false; changed(); } }
}
export async function answerCall(video: boolean) {
  const call = active, epoch = mediaEpoch;
  if (!call || call.state !== CallState.Ringing || busy) return;
  busy = true; changed();
  try {
    const { current, owned, servers } = await requireRelay(call.roomId);
    const answering = () => owned() && active === call && epoch === mediaEpoch && call.state === CallState.Ringing;
    if (!answering()) return;
    const peer = call.peerConn;
    if (!peer) throw new Error(callRelayError);
    configureInitialCallRelay(peer, servers, () => answering() && call.peerConn === peer);
    if (media.pushToTalk || media.deafened) {
      const feed = await mutedFeed(current, call.roomId, video);
      if (!answering()) { current.getMediaHandler().stopUserMediaStream(feed.stream); return; }
      try { configureInitialCallRelay(peer, currentCallRelay(current), () => answering() && call.peerConn === peer); }
      catch (failure) { current.getMediaHandler().stopUserMediaStream(feed.stream); throw failure; }
      await call.answerWithCallFeeds([feed]);
    } else await call.answer(true, video);
    if (owned() && active === call && epoch === mediaEpoch) changed();
  } finally { if (active === call && epoch === mediaEpoch) { busy = false; changed(); } }
}
export function endCall() { mediaEpoch++; if (active?.state === CallState.Ringing) active.reject(); else if (active && active.state !== CallState.Ended) active.hangup(CallErrorCode.UserHangup, false); detach?.(); detach = null; active = null;releaseMedia('direct'); busy = false; error = ''; changed(); }
export async function toggleCall(kind: 'mic' | 'camera' | 'screen') {
  if (!active) return;
  if (kind === 'mic') { if (media.pushToTalk || media.deafened) throw new Error('Disable push to talk or deafen before unmuting your microphone.'); await active.setMicrophoneMuted(!active.isMicrophoneMuted()); }
  if (kind === 'camera') await active.setLocalVideoMuted(!active.isLocalVideoMuted());
  if (kind === 'screen') await active.setScreensharingEnabled(!active.isScreensharing(), { audio: true });
  changed();
}
async function mutedFeed(current: MatrixClient, roomId: string, video: boolean) {
  const stream = await current.getMediaHandler().getUserMediaStream(true, video);
  for (const track of stream.getAudioTracks()) track.enabled = false;
  return new CallFeed({ client: current, roomId, userId: current.getUserId()!, deviceId: current.getDeviceId() || undefined, stream, purpose: SDPStreamMetadataPurpose.Usermedia, audioMuted: true, videoMuted: false });
}
/** Update the local gate synchronously: SDK microphone toggles await device enumeration. */
function gateMicrophone(call: MatrixCall, muted: boolean) {
  call.localUsermediaFeed?.setAudioVideoMuted(muted, null);
  for (const track of call.localUsermediaStream?.getAudioTracks() || []) track.enabled = !muted && !call.isRemoteOnHold();
}
function muteTracks() { if (active) gateMicrophone(active, true); }
let settingsChange: Promise<void> = Promise.resolve();
export async function setCallMediaSettings(patch: Partial<CallMediaSettings>) {
  if (patch.outputVolume !== undefined && (!Number.isFinite(patch.outputVolume) || patch.outputVolume < 0 || patch.outputVolume > 1)) throw new Error('Choose a volume from 0 to 100%.');
  // Privacy toggles take effect before any asynchronous device replacement.
  const talkModeChanged = patch.pushToTalk !== undefined && patch.pushToTalk !== media.pushToTalk;
  if (patch.deafened === true || talkModeChanged) { media = { ...media, ...(patch.deafened === true ? { deafened: true } : {}), ...(talkModeChanged ? { pushToTalk: patch.pushToTalk! } : {}) }; muteTracks(); changed(); }
  const apply = async () => {
    const next = { ...media, ...patch }, handler = client?.getMediaHandler();
    const changedInputs = next.audioInput !== media.audioInput || next.videoInput !== media.videoInput, changedProcessing = next.noiseSuppression !== media.noiseSuppression || next.echoCancellation !== media.echoCancellation || next.autoGainControl !== media.autoGainControl;
    if (handler && changedInputs) await handler.setMediaInputs(next.audioInput, next.videoInput);
    if (handler && changedProcessing) await handler.setAudioSettings({ noiseSuppression: next.noiseSuppression, echoCancellation: next.echoCancellation, autoGainControl: next.autoGainControl });
    media = { ...media, ...patch };
    try { localStorage.setItem('tavern.call-devices', JSON.stringify({ audioInput: media.audioInput, videoInput: media.videoInput, audioOutput: media.audioOutput })); } catch { /* Continue with session preferences. */ }
    if (media.deafened || talkModeChanged || (media.pushToTalk && (changedInputs || changedProcessing))) { muteTracks(); await active?.sendMetadataUpdate(); }
    changed();
  };
  const pending = settingsChange.catch(() => {}).then(apply); settingsChange = pending;
  return pending;
}
let talkSequence = 0;
export async function setCallTalking(talking: boolean) {
  const sequence = ++talkSequence, call = active;
  if (!call || call.state === CallState.Ended || !media.pushToTalk) return;
  const muted = !talking || media.deafened;
  if (!muted && !call.localUsermediaStream?.getAudioTracks().length) throw new Error('Your microphone is not ready. Check call device settings.');
  gateMicrophone(call, muted);
  changed();
  try { await call.sendMetadataUpdate(); }
  catch (error) { if (sequence === talkSequence && call === active) { muteTracks(); changed(); } throw error; }
}
export function watchFeed(feed: CallFeed, fn: () => void) { feed.on(CallFeedEvent.NewStream, fn); feed.on(CallFeedEvent.MuteStateChanged, fn); return () => { feed.off(CallFeedEvent.NewStream, fn); feed.off(CallFeedEvent.MuteStateChanged, fn); }; }
