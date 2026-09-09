import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { normalizeNotificationPreferences: normalize, resolveNotificationPreference: resolve, notificationEligible, notificationServerForRoom, updateNotificationPreferences } = loadTs('../lib/notification-preferences.ts', { './matrix': {} });
test('notification channel overrides inherit server and global defaults without clearing ancestor mutes', () => {
  const prefs = normalize({ global: { mode: 'all' }, servers: { '!s:local': { mode: 'mentions', mutedUntil: 2000 } }, rooms: { '!r:local': { mode: 'all' } } });
  assert.deepEqual(resolve(prefs, '!other:local', '!s:local', 1000), { mode: 'mentions', source: 'Server', muted: true, mutedUntil: 2000, sound: false });
  assert.equal(resolve(prefs, '!r:local', '!s:local', 1000).mode, 'all');
  assert.equal(resolve(prefs, '!r:local', '!s:local', 1000).muted, true);
  assert.equal(resolve(prefs, '!r:local', '!s:local', 2000).muted, false);
  assert.equal(resolve(prefs, '!other:local', undefined, 1000).mode, 'all');
});
test('indefinite and overlapping mutes remain active until every applicable level is unmuted', () => {
  const prefs = normalize({ global: { mutedUntil: 3000 }, servers: { '!s:local': { mutedUntil: 2000 } }, rooms: { '!r:local': { mutedUntil: -1 } } });
  assert.equal(resolve(prefs, '!r:local', '!s:local', 1000).mutedUntil, -1);
  assert.equal(resolve(prefs, '!r:local', '!s:local', 10000).muted, true);
  prefs.rooms['!r:local'].mutedUntil = 0;
  assert.equal(resolve(prefs, '!r:local', '!s:local', 1000).mutedUntil, 3000);
  assert.equal(resolve(prefs, '!r:local', '!s:local', 3001).muted, false);
});
test('notifications respect ignored senders, DND, own messages, native denies and mention-only modes', () => {
  const setting = resolve(normalize({ global: { mode: 'mentions' } })), options = { mention: false, ignored: false, dnd: false, own: false, nativeNotify: true };
  assert.equal(notificationEligible(setting, options), false);
  assert.equal(notificationEligible(setting, { ...options, mention: true }), true);
  for (const field of ['ignored', 'dnd', 'own']) assert.equal(notificationEligible(setting, { ...options, mention: true, [field]: true }), false);
  assert.equal(notificationEligible(setting, { ...options, mention: true, nativeNotify: false }), false);
  assert.equal(notificationEligible({ ...setting, mode: 'nothing' }, { ...options, mention: true }), false);
});
test('malformed values cannot create infinite accidental mutes or invalid scopes', () => {
  const prefs = normalize({ global: { mode: 'invalid', sound: 'true', mutedUntil: Infinity }, rooms: { invalid: { mode: 'nothing' }, '!r:local': { mode: 'invalid', mutedUntil: -500 } } });
  assert.equal(prefs.global.mode, 'all'); assert.equal(prefs.global.sound, false); assert.equal(prefs.global.mutedUntil, 0);
  assert.deepEqual(Object.keys(prefs.rooms), ['!r:local']); assert.deepEqual(prefs.rooms['!r:local'], { mode: 'inherit', mutedUntil: 0 });
});
test('server notification scope uses reciprocal canonical Space links', () => {
  const parent = id => ({ getContent: () => ({ via: ['local'], canonical: true }), getStateKey: () => id });
  const c = { getRoom: id => id === '!room:local' ? { isSpaceRoom: () => false, currentState: { getStateEvents: () => [parent('!forged:local'), parent('!space:local')] } } : { currentState: { getStateEvents: () => ({ getContent: () => id === '!space:local' ? { via: ['local'] } : {} }) } } };
  assert.equal(notificationServerForRoom(c, '!room:local'), '!space:local');
});
test('queued preference writes refresh account state and preserve sibling changes', async () => {
  let stored = undefined;
  const c = { getAccountDataFromServer: async () => structuredClone(stored), setAccountData: async (_key, value) => { stored = structuredClone(value); } };
  await Promise.all([
    updateNotificationPreferences(p => ({ ...p, rooms: { ...p.rooms, '!a:local': { mode: 'nothing', mutedUntil: 0 } } }), c),
    updateNotificationPreferences(p => ({ ...p, rooms: { ...p.rooms, '!b:local': { mode: 'mentions', mutedUntil: 0 } } }), c),
  ]);
  assert.deepEqual(Object.keys(stored.rooms), ['!a:local', '!b:local']);
});
