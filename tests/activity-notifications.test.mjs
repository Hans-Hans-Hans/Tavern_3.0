import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

function fixture() {
  const f = { prefs: null, ignored: [], presence: 'online', focus: false, managed: true, social: { requests: [], blocked: [], privacy: 'everyone' }, call: null, deliveries: [], closed: [], errors: [], reads: 0, stops: 0, beforeRead: null };
  const room = { roomId: '!dm:local', isSpaceRoom: () => false, getMyMembership: () => 'join', currentState: { getStateEvents: type => type === 'm.space.parent' ? [] : null } };
  f.client = { getUserId: () => '@me:local', getIgnoredUsers: () => f.ignored, getRooms: () => [room], getRoom: id => id === room.roomId ? room : null, getAccountData: () => f.prefs ? { getContent: () => f.prefs } : null };
  f.active = f.client; f.callClient = f.client;
  const matrix = { getMatrixClient: () => f.active };
  f.preferences = loadTs('../lib/notification-preferences.ts', { './matrix': matrix });
  f.api = loadTs('../lib/activity-notifications.ts', { './matrix': matrix, './api': { isManagedAccount: () => f.managed }, './calls': { callSnapshot: () => ({ call: f.call, client: f.callClient, media: { deafened: f.deafened } }), subscribeCalls: callback => { f.callChanged = callback; return () => { f.callChanged = () => {}; f.stops++; }; } }, './social': { socialApi: async () => { f.reads++; if (f.beforeRead) await f.beforeRead(); return structuredClone(f.social); }, observeContacts: callback => { f.contactChanged = callback; return () => { f.contactChanged = () => {}; f.stops++; }; } }, './presence': { readPresenceMode: () => f.presence }, './notification-preferences': f.preferences, './notifications': { notificationFocusEnabled: () => f.focus }, 'matrix-js-sdk/lib/webrtc/call': { CallDirection: { Inbound: 'inbound' }, CallState: { Ringing: 'ringing' } } });
  f.start = () => f.running = f.api.startActivityNotifications(f.client, (signal, options) => { f.deliveries.push({ signal, options }); return () => f.closed.push(signal.id); }, message => f.errors.push(message));
  f.request = (id, extra = {}) => ({ id, sender: '@friend:local', target: '@me:local', status: 'pending', created: 100, ...extra });
  f.ring = (id, extra = {}) => { f.call = { callId: id, roomId: '!dm:local', direction: 'inbound', state: 'ringing', getOpponentMember: () => ({ userId: '@friend:local' }), ...extra }; f.callChanged(); };
  return f;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('contact SSE baseline and reconnects do not replay requests; new pending requests alert once and close when resolved', async () => {
  const f = fixture(); f.social.requests = [f.request('old', { created: 10 })]; f.start(); await settle();
  assert.equal(f.deliveries.length, 0);
  f.social.requests.push(f.request('new'), f.request('outgoing', { sender: '@me:local', target: '@friend:local' }), f.request('accepted', { status: 'accepted' }));
  f.contactChanged(); await settle(); f.contactChanged(); await settle();
  assert.deepEqual(f.deliveries.map(value => value.signal.id), ['friend:new']);
  f.social.requests = []; f.contactChanged(); await settle();
  assert.deepEqual(f.closed, ['friend:new']); f.running.stop(); assert.equal(f.stops, 2);
});

test('friend and call alert gates honor event choices, mutes, DND, focus, ignored users and request privacy', () => {
  const f = fixture(), friend = { id: 'friend:r', kind: 'friend', sender: '@friend:local' }, call = { id: 'call:r', kind: 'call', sender: '@friend:local', roomId: '!dm:local' };
  assert.equal(f.api.activityNotificationAllowed(f.client, friend), true);
  f.prefs = f.preferences.normalizeNotificationPreferences({ global: { mode: 'mentions' } });
  assert.equal(f.api.activityNotificationAllowed(f.client, call), true);
  for (const patch of [{ mode: 'nothing' }, { mutedUntil: -1 }, { incomingCalls: false }]) {
    f.prefs = f.preferences.normalizeNotificationPreferences({ global: patch }); assert.equal(f.api.activityNotificationAllowed(f.client, call), false);
  }
  f.prefs = f.preferences.normalizeNotificationPreferences({ global: { friendRequests: false } }); assert.equal(f.api.activityNotificationAllowed(f.client, friend), false);
  f.prefs = f.preferences.normalizeNotificationPreferences({ rooms: { '!dm:local': { mutedUntil: Date.now() + 50000 } } }); assert.equal(f.api.activityNotificationAllowed(f.client, call), false);
  f.prefs = null; f.presence = 'dnd'; assert.equal(f.api.activityNotificationAllowed(f.client, friend), false);
  f.presence = 'online'; f.focus = true; assert.equal(f.api.activityNotificationAllowed(f.client, call), false);
  f.focus = false; f.ignored = ['@friend:local']; assert.equal(f.api.activityNotificationAllowed(f.client, call), false);
  f.ignored = []; assert.equal(f.api.activityNotificationAllowed(f.client, friend, ['@friend:local']), false);
  assert.equal(f.api.activityNotificationAllowed(f.client, friend, [], 'nobody'), false);
  assert.equal(f.api.activityNotificationAllowed(f.client, friend, [], 'shared_server'), false);
  f.client.getRooms = () => [{ isSpaceRoom: () => true, getMyMembership: () => 'join', getMember: () => ({ membership: 'join' }) }];
  assert.equal(f.api.activityNotificationAllowed(f.client, friend, [], 'shared_server'), true);
});

test('inbound call subscriptions deduplicate feed changes, dismiss ended calls, and retain session provenance', async () => {
  const f = fixture(); f.prefs = f.preferences.normalizeNotificationPreferences({ global: { sound: true } }); f.start(); await settle();
  f.ring('one'); f.callChanged(); f.callChanged();
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].options.sound, true);
  f.call.state = 'connected'; f.callChanged(); assert.deepEqual(f.closed, ['call:!dm:local:one']);
  f.ring('outbound', { direction: 'outbound' }); f.ring('conference', { groupCallId: 'group' });
  f.callClient = {}; f.ring('old-session'); assert.equal(f.deliveries.length, 1);
  f.callClient = f.client; f.deafened = true; f.ring('two'); assert.equal(f.deliveries[1].options.sound, false);
  f.presence = 'dnd'; f.running.recheck(); assert.ok(f.closed.includes('call:!dm:local:two'));
  f.running.stop();
});

test('coalesced updates bound requests and discard responses after logout or an account switch', async () => {
  const f = fixture(); let release; f.beforeRead = () => new Promise(resolve => { release = resolve; });
  f.start(); for (let i = 0; i < 25; i++) f.contactChanged(); assert.equal(f.reads, 1);
  f.beforeRead = null; release(); await settle(); assert.equal(f.reads, 2);
  let finish; f.beforeRead = () => new Promise(resolve => { finish = resolve; }); f.social.requests = [f.request('late')]; f.contactChanged();
  f.running.stop(); f.active = {}; finish(); await settle();
  assert.deepEqual(f.deliveries, []); assert.equal(f.stops, 2);
});

test('external Matrix accounts get direct call alerts without opening managed contact APIs', async () => {
  const f = fixture(); f.managed = false; f.start(); await settle(); assert.equal(f.reads, 0);
  f.ring('external'); assert.equal(f.deliveries.length, 1); f.running.stop();
});

test('contact event streams are shared per current account and close after the final observer leaves', () => {
  const streams = [], generation = {}; let client = { getUserId: () => '@owner:local' };
  globalThis.EventSource = class { constructor() { streams.push(this); } close() { this.closed = true; } };
  const social = loadTs('../lib/social.ts', { './matrix': { getMatrixClient: () => client }, './api': { accountArtworkOwner: () => generation } });
  let first = 0, second = 0;
  const one = social.observeContacts(() => first++), two = social.observeContacts(() => second++);
  assert.equal(streams.length, 1); streams[0].onmessage(); assert.equal(first, 1); assert.equal(second, 1);
  one(); assert.equal(streams[0].closed, undefined); two(); assert.equal(streams[0].closed, true);
  const old = social.observeContacts(() => first++); const previous = streams.at(-1); client = { getUserId: () => '@replacement:local' };
  const current = social.observeContacts(() => second++); previous.onmessage(); streams.at(-1).onmessage();
  assert.equal(first, 1); assert.equal(second, 2); assert.equal(previous.closed, true); old(); current();
});
