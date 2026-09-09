import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

function fixture() {
  globalThis.window = new EventTarget();
  const f = { listeners: new Map(), writes: [], prefs: null, defaults: { version: 1, mode: 'mentions' }, beforeRules: null, foreground: null, syncState: null };
  const event = content => ({ getContent: () => content });
  const parent = { getContent: () => ({ canonical: true, via: ['local'] }), getStateKey: () => '!server:local' };
  const server = { currentState: { getStateEvents: type => type === 'm.space.child' ? event({ via: ['local'] }) : type === 'io.tavern.notification.defaults' ? event(f.defaults) : null } };
  const room = { roomId: '!room:local', getMyMembership: () => 'join', isSpaceRoom: () => false, currentState: { getStateEvents: type => type === 'm.space.parent' ? [parent] : null } };
  f.client = { on: (key, fn) => f.listeners.set(key, fn), off: key => f.listeners.delete(key), getUserId: () => '@member:local', getRooms: () => [room], getRoom: id => id === room.roomId ? room : server, getAccountData: () => f.prefs ? event(f.prefs) : null, getPushRules: async () => { if (f.beforeRules) await f.beforeRules(); return { global: { override: [] } }; }, setPushRules: () => {}, addPushRule: async (...args) => f.writes.push(args), deletePushRule: async (...args) => f.writes.push(['delete', ...args]) };
  f.preferences = loadTs('../lib/notification-preferences.ts', { './matrix': { getMatrixClient: () => f.client } });
  f.client.getDeviceId = () => 'DEVICE';
  f.client.getSyncState = () => f.syncState;
  f.api = loadTs('../lib/notifications.ts', { './web-push': { refreshWebPushForeground: () => {}, setWebPushForegroundHandler: value => { f.foreground = value; } }, './presence': {}, './thread-preferences': {}, './notification-preferences': f.preferences, 'matrix-js-sdk': { ClientEvent: { Sync: 'sync' }, RoomEvent: { Timeline: 'timeline' }, MatrixEventEvent: { Decrypted: 'decrypted' }, RoomStateEvent: { Events: 'state' } }, 'matrix-js-sdk/lib/@types/PushRules': { ConditionKind: { EventMatch: 'event_match' }, PushRuleActionName: { Notify: 'notify' }, PushRuleKind: { Override: 'override', RoomSpecific: 'room' } } });
  f.sync = (state = 'SYNCING') => { f.syncState = state; f.listeners.get('sync')(state); };
  f.api.initializeNotifications(f.client);
  return f;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 350));

test('background delivery handoff requires the current connected device and an active alert surface', () => {
  const f = fixture();
  globalThis.document = { visibilityState: 'visible' };
  let enabled = false;
  globalThis.localStorage = { getItem: () => enabled ? 'enabled' : null };
  globalThis.Notification = { permission: 'granted' };
  try {
    assert.equal(f.foreground('DEVICE'), false);
    f.sync();
    assert.equal(f.foreground('DEVICE'), true);
    assert.equal(f.foreground('OTHER'), false);
    document.visibilityState = 'hidden';
    assert.equal(f.foreground('DEVICE'), false);
    enabled = true;
    assert.equal(f.foreground('DEVICE'), true);
    f.sync('ERROR');
    assert.equal(f.foreground('DEVICE'), false);
    f.sync('STOPPED');
    assert.equal(f.foreground('DEVICE'), false);
    f.sync('PREPARED');
    assert.equal(f.foreground('DEVICE'), true);
    const stale = f.foreground;
    f.api.resetNotifications();
    assert.equal(f.foreground, null);
    assert.equal(stale('DEVICE'), false);
  } finally {
    f.api.resetNotifications();
    delete globalThis.document; delete globalThis.localStorage; delete globalThis.Notification;
  }
});

test('native rules receive server defaults once and follow personal choices on later synchronization', async () => {
  const f = fixture();
  try {
    const inherited = f.preferences.normalizeNotificationPreferences({ servers: { '!server:local': { mode: 'nothing', mutedUntil: -1 } } });
    assert.equal(f.preferences.resolveNotificationPreference(inherited, '!room:local').source, 'Server');
    assert.equal(f.preferences.resolveNotificationPreference(inherited, '!room:local').muted, true);
    f.sync(); await settle();
    assert.deepEqual(f.writes, [['global', 'room', '!room:local', { actions: [] }]]);
    f.sync(); await settle(); assert.equal(f.writes.length, 1);
    f.prefs = f.preferences.normalizeNotificationPreferences({ global: { mode: 'all', useServerDefaults: false } });
    f.sync(); await settle(); assert.deepEqual(f.writes[1], ['global', 'room', '!room:local', { actions: ['notify'] }]);
    assert.equal(f.api.notificationDefaultsSyncError(), '');
  } finally { f.api.resetNotifications(); }
});

test('native default writes stop if the account or personal mode changes during the network read', async () => {
  const f = fixture();
  try {
    f.beforeRules = async () => { f.beforeRules = null; f.prefs = f.preferences.normalizeNotificationPreferences({ global: { mode: 'nothing' } }); };
    f.sync(); await settle();
    assert.deepEqual(f.writes, []);
    assert.match(f.api.notificationDefaultsSyncError(), /could not be synchronized/);
  } finally { f.api.resetNotifications(); }
  const other = fixture();
  try {
    other.beforeRules = async () => { other.beforeRules = null; other.api.resetNotifications(); };
    other.sync(); await settle(); assert.deepEqual(other.writes, []);
  } finally { other.api.resetNotifications(); }
});
