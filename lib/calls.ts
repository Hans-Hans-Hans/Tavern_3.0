import { claimMedia, releaseMedia, mediaOwner } from './media-session';
import { CallEvent, CallFeedEvent, type MatrixClient, type MatrixCall } from 'matrix-js-sdk';
import type { CallFeed } from 'matrix-js-sdk/lib/webrtc/callFeed';
import { CallEventHandlerEvent } from 'matrix-js-sdk/lib/webrtc/callEventHandler';
import { CallErrorCode, CallState } from 'matrix-js-sdk/lib/webrtc/call';
let client: MatrixClient | null = null;
let active: MatrixCall | null = null;
let error = '';
let busy = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(fn => fn());
let detach: (() => void) | null = null;
export function subscribeCalls(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function callSnapshot() { return { call: active, error, busy }; }
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
  const room = client?.getRoom(call.roomId);
  if (!room || room.getMyMembership() !== 'join' || !room.hasEncryptionStateEvent() || room.getJoinedMemberCount() !== 2 || (active && active.state !== CallState.Ended) || mediaOwner()==='conference') { call.reject(); return; }
  attach(call);
}
export function initializeCalls(c: MatrixClient) { resetCalls(); client = c; c.on(CallEventHandlerEvent.Incoming, incoming); }
export function resetCalls() { if (active && active.state !== CallState.Ended) active.hangup(CallErrorCode.UserHangup, false); detach?.(); detach = null; client?.off(CallEventHandlerEvent.Incoming, incoming); client = null; active = null;releaseMedia('direct'); busy = false; error = ''; changed(); }
async function requireRelay() {
  if (!client) throw new Error('Sign in before starting a call.');
  await client.checkTurnServers();
  if (!client.getTurnServers().length) throw new Error('Your administrator must configure self-hosted TURN before calls can connect. Tavern requires relay-only calls to protect participant IP addresses.');
}
export async function startCall(roomId: string, video: boolean) {
  if (busy || (active && active.state !== CallState.Ended) || mediaOwner()==='conference') throw new Error('Finish the current call first.');
  claimMedia('direct');busy = true; changed();
  try {
    await requireRelay();
    const room = client!.getRoom(roomId);
    if (!room?.hasEncryptionStateEvent() || room.getMyMembership() !== 'join') throw new Error('Calls require a joined encrypted conversation.');
    if (room.getJoinedMemberCount() !== 2) throw new Error('Use the conference button for group calls. Direct calls require exactly two joined members.');
    const call = client!.createCall(roomId); if (!call) throw new Error('WebRTC is not available in this browser.'); attach(call);
    if (video) await call.placeVideoCall(); else await call.placeVoiceCall();
  } catch (e) { error = (e as Error).message; if (active && active.state !== CallState.Ended) active.hangup(CallErrorCode.UserHangup, false); releaseMedia('direct');throw e; }
  finally { busy = false; changed(); }
}
export async function answerCall(video: boolean) { await requireRelay(); await active?.answer(true, video); changed(); }
export function endCall() { if (active?.state === CallState.Ringing) active.reject(); else if (active && active.state !== CallState.Ended) active.hangup(CallErrorCode.UserHangup, false); detach?.(); detach = null; active = null;releaseMedia('direct'); error = ''; changed(); }
export async function toggleCall(kind: 'mic' | 'camera' | 'screen') {
  if (!active) return;
  if (kind === 'mic') await active.setMicrophoneMuted(!active.isMicrophoneMuted());
  if (kind === 'camera') await active.setLocalVideoMuted(!active.isLocalVideoMuted());
  if (kind === 'screen') await active.setScreensharingEnabled(!active.isScreensharing(), { audio: true });
  changed();
}
export function watchFeed(feed: CallFeed, fn: () => void) { feed.on(CallFeedEvent.NewStream, fn); feed.on(CallFeedEvent.MuteStateChanged, fn); return () => { feed.off(CallFeedEvent.NewStream, fn); feed.off(CallFeedEvent.MuteStateChanged, fn); }; }
