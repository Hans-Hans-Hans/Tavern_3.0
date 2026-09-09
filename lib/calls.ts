import { claimMedia, releaseMedia, mediaOwner } from './media-session';
import { CallEvent, CallFeedEvent, type MatrixClient, type MatrixCall } from 'matrix-js-sdk';
import { CallFeed } from 'matrix-js-sdk/lib/webrtc/callFeed';
import { SDPStreamMetadataPurpose } from 'matrix-js-sdk/lib/webrtc/callEventTypes';
import { readInstanceConfig } from './instance';
import { CallEventHandlerEvent } from 'matrix-js-sdk/lib/webrtc/callEventHandler';
import { CallErrorCode, CallState } from 'matrix-js-sdk/lib/webrtc/call';
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
  if (call.groupCallId) return;
  const sender = call.getOpponentMember()?.userId;
  if (sender && client?.getIgnoredUsers().includes(sender)) { call.reject(); return; }
  const room = client?.getRoom(call.roomId);
  if (!room || room.getMyMembership() !== 'join' || !room.hasEncryptionStateEvent() || room.getJoinedMemberCount() !== 2 || busy || (active && active.state !== CallState.Ended) || mediaOwner()==='conference') { call.reject(); return; }
  attach(call);
}
export function initializeCalls(c: MatrixClient) { resetCalls(); client = c; c.getMediaHandler().restoreMediaSettings(media.audioInput, media.videoInput); c.on(CallEventHandlerEvent.Incoming, incoming); }
export function resetCalls() { mediaEpoch++; if (active && active.state !== CallState.Ended) active.hangup(CallErrorCode.UserHangup, false); detach?.(); detach = null; client?.off(CallEventHandlerEvent.Incoming, incoming); client = null; active = null;releaseMedia('direct'); busy = false; error = ''; changed(); }
async function requireRelay() {
  const current = client;
  if (!current) throw new Error('Sign in before starting a call.');
  if (!await callsConfigured()) throw new Error('Your administrator must enable calls and configure TURN before you can connect.');
  if (current !== client) throw new Error('The call was canceled.');
  await current.checkTurnServers();
  if (current !== client) throw new Error('The call was canceled.');
  if (!current.getTurnServers().length) throw new Error('Your administrator must configure self-hosted TURN before calls can connect. Tavern requires relay-only calls to protect participant IP addresses.');
  return current;
}
export async function startCall(roomId: string, video: boolean) {
  if (busy || (active && active.state !== CallState.Ended) || mediaOwner()==='conference') throw new Error('Finish the current call first.');
  claimMedia('direct'); const epoch = ++mediaEpoch; let started: MatrixCall | null = null; busy = true; changed();
  try {
    const current = await requireRelay();
    if (epoch !== mediaEpoch) throw new Error('The call was canceled.');
    const room = current.getRoom(roomId);
    if (!room?.hasEncryptionStateEvent() || room.getMyMembership() !== 'join') throw new Error('Calls require a joined encrypted conversation.');
    if (room.getJoinedMemberCount() !== 2) throw new Error('Use the conference button for group calls. Direct calls require exactly two joined members.');
    const call = current.createCall(roomId); if (!call) throw new Error('WebRTC is not available in this browser.'); started = call; attach(call);
    if (media.pushToTalk || media.deafened) {
      const feed = await mutedFeed(current, roomId, video);
      if (epoch !== mediaEpoch || active !== call || call.state === CallState.Ended) { current.getMediaHandler().stopUserMediaStream(feed.stream); throw new Error('The call was canceled.'); }
      await call.placeCallWithCallFeeds([feed]);
    }
    else if (video) await call.placeVideoCall(); else await call.placeVoiceCall();
  } catch (e) { if (epoch === mediaEpoch) { error = (e as Error).message; if (started && started.state !== CallState.Ended) started.hangup(CallErrorCode.UserHangup, false); releaseMedia('direct'); } throw e; }
  finally { if (epoch === mediaEpoch) { busy = false; changed(); } }
}
export async function answerCall(video: boolean) {
  const call = active, epoch = mediaEpoch, current = await requireRelay();
  if (!call || active !== call || epoch !== mediaEpoch || call.state === CallState.Ended) return;
  if (media.pushToTalk || media.deafened) {
    const feed = await mutedFeed(current, call.roomId, video);
    if (active !== call || epoch !== mediaEpoch || hasEnded(call)) { current.getMediaHandler().stopUserMediaStream(feed.stream); return; }
    await call.answerWithCallFeeds([feed]);
  } else await call.answer(true, video);
  changed();
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
