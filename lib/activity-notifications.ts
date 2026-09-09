import type { MatrixClient } from 'matrix-js-sdk';
import { CallDirection, CallState } from 'matrix-js-sdk/lib/webrtc/call';
import { getMatrixClient } from './matrix';
import { isManagedAccount } from './api';
import { callSnapshot, subscribeCalls } from './calls';
import { observeContacts, socialApi, type SocialState } from './social';
import { readPresenceMode } from './presence';
import { notificationEligible, readNotificationPreferences, resolveNotificationPreference } from './notification-preferences';
import { notificationFocusEnabled } from './notifications';

export type ActivitySignal = { id: string; kind: 'friend' | 'call'; sender: string; roomId?: string };
export type ActivityDelivery = (signal: ActivitySignal, options: { sound: boolean }) => (() => void);

export function activityNotificationAllowed(client: MatrixClient, signal: ActivitySignal, blocked: string[] = [], requestPrivacy: SocialState['privacy'] = 'everyone') {
  const me = client.getUserId();
  if (!me || !signal.sender || signal.sender === me || notificationFocusEnabled()) return false;
  const prefs = readNotificationPreferences(client), setting = resolveNotificationPreference(prefs, signal.roomId);
  if (signal.kind === 'friend' ? !prefs.global.friendRequests || requestPrivacy === 'nobody' : !prefs.global.incomingCalls) return false;
  if (signal.kind === 'friend' && requestPrivacy === 'shared_server' && !client.getRooms().some(room => room.isSpaceRoom() && room.getMyMembership() === 'join' && room.getMember(signal.sender)?.membership === 'join')) return false;
  if (signal.kind === 'call' && (!signal.roomId || client.getRoom(signal.roomId)?.getMyMembership() !== 'join')) return false;
  return notificationEligible(setting, { mention: true, ignored: blocked.includes(signal.sender) || client.getIgnoredUsers().includes(signal.sender), dnd: readPresenceMode(client) === 'dnd', own: false });
}

/** One session, one coalesced contact read, and existing call subscriptions. */
export function startActivityNotifications(client: MatrixClient, deliver: ActivityDelivery, onError: (message: string) => void = () => {}) {
  const owner = client.getUserId(), managed = isManagedAccount(), seen = new Set<string>(), pending = new Map<string, { signal: ActivitySignal; dispose: () => void }>();
  let alive = true, loading = false, refreshAgain = false, baseline = false, baselineTime = 0, blocked: string[] = [], privacy: SocialState['privacy'] = 'everyone';
  const current = () => alive && getMatrixClient() === client && client.getUserId() === owner && (!managed || isManagedAccount());
  const remember = (key: string) => { seen.add(key); if (seen.size > 2000) seen.delete(seen.values().next().value!); };
  const dismiss = (key: string) => { pending.get(key)?.dispose(); pending.delete(key); };
  const emit = (signal: ActivitySignal) => {
    if (!current() || seen.has(signal.id)) return;
    remember(signal.id);
    if (!activityNotificationAllowed(client, signal, blocked, privacy)) return;
    const dispose = deliver(signal, { sound: readNotificationPreferences(client).global.sound && (signal.kind !== 'call' || !callSnapshot().media.deafened) });
    pending.set(signal.id, { signal, dispose });
    if (pending.size > 100) dismiss(pending.keys().next().value!);
  };
  const recheck = () => { for (const [key, item] of pending) if (!current() || !activityNotificationAllowed(client, item.signal, blocked, privacy)) dismiss(key); };
  async function refreshContacts() {
    if (!managed || !current()) return;
    if (loading) { refreshAgain = true; return; }
    loading = true;
    try {
      do {
        refreshAgain = false;
        const state = await socialApi();
        if (!current()) return;
        if (!Array.isArray(state.requests) || state.requests.length > 500 || !Array.isArray(state.blocked)) throw new Error('Invalid contact update.');
        blocked = state.blocked.slice(0, 1000); privacy = state.privacy;
        const incoming = state.requests.filter(request => request.status === 'pending' && request.target === owner && typeof request.id === 'string' && typeof request.sender === 'string' && Number.isFinite(request.created));
        const active = new Set(incoming.map(request => 'friend:' + request.id));
        for (const [key, item] of pending) if (item.signal.kind === 'friend' && !active.has(key)) dismiss(key);
        recheck();
        if (!baseline) {
          baselineTime = Math.max(0, ...state.requests.map(request => Number.isFinite(request.created) ? request.created : 0));
          incoming.forEach(request => remember('friend:' + request.id)); baseline = true;
        } else for (const request of incoming) {
          if (request.created < baselineTime) continue;
          emit({ id: 'friend:' + request.id, kind: 'friend', sender: request.sender });
        }
        onError('');
      } while (refreshAgain && current());
    } catch { if (current()) onError('Friend request alerts could not refresh. Open Contacts to check your requests.'); }
    finally { loading = false; }
  }
  const changedCall = () => {
    if (!current()) return;
    const { call, client: callClient } = callSnapshot();
    const ringing = callClient === client && call?.state === CallState.Ringing && call.direction === CallDirection.Inbound && !call.groupCallId;
    const key = ringing ? 'call:' + call.roomId + ':' + call.callId : '';
    for (const [id, item] of pending) if (item.signal.kind === 'call' && id !== key) dismiss(id);
    if (ringing) {
      const sender = call.getOpponentMember()?.userId;
      if (sender) emit({ id: key, kind: 'call', sender, roomId: call.roomId });
    }
    recheck();
  };
  const stopCalls = subscribeCalls(changedCall), stopContacts = managed ? observeContacts(() => { void refreshContacts(); }) : () => {};
  changedCall(); if (managed) void refreshContacts();
  return {
    recheck: () => { recheck(); changedCall(); },
    stop: () => { if (!alive) return; alive = false; stopCalls(); stopContacts(); for (const key of pending.keys()) dismiss(key); seen.clear(); },
  };
}
