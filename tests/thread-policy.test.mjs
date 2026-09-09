import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

function fixture() {
  let user = '@author:test', metadata = {};
  const writes = [], root = { getSender: () => '@author:test' }, powers = { '@author:test': 0, '@member:test': 0, '@mod:test': 50 };
  const room = { getMyMembership: () => 'join', findEventById: () => root, getThread: () => null, getMember: id => ({ powerLevel: powers[id] }), currentState: { maySendStateEvent: () => true, getStateEvents: type => ({ getContent: () => type === 'io.tavern.thread' ? metadata : { redact: 50, events: { 'io.tavern.thread': 0 } } }) } };
  const client = { getUserId: () => user, getRoom: () => room, fetchRoomEvent: async () => ({ sender: '@author:test', room_id: '!room:test' }), getStateEvent: async () => metadata, sendStateEvent: async (...args) => writes.push(args) };
  const api = loadTs('../lib/thread-policy.ts', { './matrix': { getMatrixClient: () => client }, './channel-policy': { roomContext: () => ({ room, me: user, client, policies: [], unknownPolicy: false }) }, './roles': { effectiveRolePermissions: () => new Set() } });
  return { api, writes, setUser: id => user = id, setMetadata: value => metadata = value };
}

test('only author or moderator can edit thread metadata; locked author cannot override', () => { const f = fixture(); assert.equal(f.api.canEditThreadPolicy('!room:test', '$root'), true); f.setUser('@member:test'); assert.equal(f.api.canEditThreadPolicy('!room:test', '$root'), false); f.setUser('@mod:test'); assert.equal(f.api.canEditThreadPolicy('!room:test', '$root'), true); f.setMetadata({ locked: true }); f.setUser('@author:test'); assert.equal(f.api.canEditThreadPolicy('!room:test', '$root'), false); });
test('author cannot create moderator lock or write invalid metadata', async () => { const f = fixture(); const value = f.api.normalizeThreadPolicy({}); await assert.rejects(f.api.saveThreadPolicy('!room:test', '$root', { ...value, locked: true })); await assert.rejects(f.api.saveThreadPolicy('!room:test', '$root', { ...value, tags: ['x'.repeat(33)] })); assert.equal(f.writes.length, 0); });
test('reopen writes a root-bound request without replacing encrypted root content', async () => { const f = fixture(); await f.api.saveThreadPolicy('!room:test', '$root', f.api.normalizeThreadPolicy({ title: 'Open discussion', autoArchiveSeconds: 3600 }), true); assert.equal(f.writes[0][0], '!room:test'); assert.equal(f.writes[0][1], 'io.tavern.thread'); assert.equal(f.writes[0][3], '$root'); assert.equal(f.writes[0][2].reopen, true); });
test('inactivity UI uses server baseline and latest activity, ignoring editable updatedAt', () => { const f = fixture(); f.setMetadata({ autoArchiveSeconds: 3600, activityStartedAt: Date.now() - 7200000, updatedAt: Date.now() }); assert.match(f.api.threadReplyRestriction('!room:test', '$root'), /inactivity/); assert.equal(f.api.threadReplyRestriction('!room:test', '$root', Date.now()), ''); });
