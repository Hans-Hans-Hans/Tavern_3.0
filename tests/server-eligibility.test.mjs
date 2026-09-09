import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

function fixture() {
  const f = { allowed: true, writes: [], saved: null, beforeState: null };
  const room = { isSpaceRoom: () => true, currentState: { getStateEvents: type => type === 'm.room.create' ? { getContent: () => ({ 'm.federate': false }), getSender: () => '@owner:local' } : type === 'io.tavern.server.eligibility' && f.saved ? { getContent: () => f.saved.content } : null } };
  const original = { getUserId: () => '@owner:local', getRoom: () => room, roomState: async () => { await f.beforeState?.(); return f.saved ? [f.saved] : []; }, sendStateEvent: async (...args) => f.writes.push(args) };
  f.client = original;
  f.api = loadTs('../lib/server-eligibility.ts', {
    './matrix': { getMatrixClient: () => f.client },
    './channel-administration': { canEditConversationState: () => f.allowed, checkedConversationState: async () => { if (!f.allowed) throw new Error('Permission changed'); return f.client; } },
  });
  return f;
}

test('server verification accepts supported native policy choices and rejects malformed saved requirements', () => {
  const f = fixture(), initial = f.api.emptyServerEligibility();
  assert.deepEqual(f.api.readServerEligibility('!server:local'), initial);
  for (const age of [0, 300, 3600, 86400, 604800]) assert.deepEqual(f.api.parseServerEligibility({ ...initial, minimumAccountAgeSeconds: age }), { ...initial, minimumAccountAgeSeconds: age });
  for (const value of [[], null, 1, { ...initial, version: 2 }, { ...initial, requireVerifiedEmail: 'true' }, { ...initial, minimumAccountAgeSeconds: -1 }, { ...initial, minimumAccountAgeSeconds: 600 }, { ...initial, allowUnverified: true }, ...['invalid', '$', '$with space', '$' + 'x'.repeat(1024)].map(revision => ({ ...initial, 'io.tavern.previous_event': revision }))]) assert.equal(f.api.parseServerEligibility(value), null);
  assert.deepEqual(f.api.parseServerEligibility({ ...initial, 'io.tavern.previous_event': '$' + 'x'.repeat(1023) }), initial);
});

test('verification saves preserve native revision and reject changes since the editor opened', async () => {
  const f = fixture(), initial = f.api.emptyServerEligibility(), next = { ...initial, requireVerifiedEmail: true, minimumAccountAgeSeconds: 86400 };
  await f.api.saveServerEligibility('!server:local', next, initial);
  assert.deepEqual(f.writes, [['!server:local', 'io.tavern.server.eligibility', { ...next, 'io.tavern.previous_event': null }, '']]);
  f.saved = { type: 'io.tavern.server.eligibility', state_key: '', event_id: '$revision', content: next };
  await assert.rejects(f.api.saveServerEligibility('!server:local', initial, initial), /settings changed/);
  assert.equal(f.writes.length, 1);
  await f.api.saveServerEligibility('!server:local', initial, next);
  assert.equal(f.writes[1][2]['io.tavern.previous_event'], '$revision');
});

test('verification makes no write after permission loss, account replacement or an unverifiable native revision', async () => {
  for (const change of ['permission', 'account', 'revision']) {
    const f = fixture(), initial = f.api.emptyServerEligibility();
    f.beforeState = async () => {
      if (change === 'permission') f.allowed = false;
      if (change === 'account') f.client = { ...f.client };
      if (change === 'revision') f.saved = { type: 'io.tavern.server.eligibility', state_key: '', content: initial };
    };
    await assert.rejects(f.api.saveServerEligibility('!server:local', { ...initial, requireVerifiedEmail: true }, initial));
    assert.deepEqual(f.writes, []);
  }
});

test('verification accepts bounded opaque native revisions and refuses malformed revision tokens', async () => {
  const f = fixture(), initial = f.api.emptyServerEligibility(), opaque = '$event/with?opaque#characters' + 'x'.repeat(500);
  f.saved = { type: 'io.tavern.server.eligibility', state_key: '', event_id: opaque, content: { ...initial, 'io.tavern.previous_event': null } };
  await f.api.saveServerEligibility('!server:local', initial, initial); assert.equal(f.writes[0][2]['io.tavern.previous_event'], opaque);
  for (const id of ['$', '$bad\nrevision', '$' + 'x'.repeat(1024)]) { f.saved.event_id = id; await assert.rejects(f.api.saveServerEligibility('!server:local', initial, initial), /revision/); }
  assert.equal(f.writes.length, 1);
});
