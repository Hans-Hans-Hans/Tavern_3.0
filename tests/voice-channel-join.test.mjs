import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
function fixture() {
  const f = { selected: true, account: {}, user: '@a:local', device: 'A', base: 'https://local', membership: 'join', kind: 'voice', direct: null, opens: [] };
  f.room = { getMyMembership: () => f.membership };
  f.client = { getUserId: () => f.user, getDeviceId: () => f.device, getHomeserverUrl: () => f.base, getRoom: () => f.room };
  f.ready = () => Promise.resolve(true);
  const module = loadTs('../lib/voice-channel-join.ts', { './api': { accountArtworkOwner: () => f.account }, './matrix': { getMatrixClient: () => f.client }, './calls': { callsConfigured: () => f.ready(), callSnapshot: () => ({ call: f.direct }) }, './channel-policy': { readChannelPolicy: () => ({ kind: f.kind }) }, './conference-session': { openConference: id => f.opens.push(id) } });
  f.join = () => module.joinVoiceChannel('!voice:local', () => f.selected); return f;
}
test('an explicit voice selection joins while a preview or a text channel never starts a call', async () => {
  const f = fixture(); assert.equal(f.opens.length, 0); await f.join(); assert.deepEqual(f.opens, ['!voice:local']);
  for (const kind of ['text','video']) { f.kind = kind; await f.join(); } f.kind = 'voice'; f.selected = false; await f.join(); assert.equal(f.opens.length, 1);
});
test('late voice access cannot join a departed channel or replacement identity', async () => {
  for (const change of [f => f.selected = false, f => f.account = {}, f => f.device = 'B', f => f.user = '@b:local', f => f.base = 'https://other', f => f.membership = 'leave', f => f.kind = 'text', f => f.room = { getMyMembership: () => 'join' }]) {
    const f = fixture(); let release; f.ready = () => new Promise(resolve => release = resolve); const pending = f.join(); change(f); release(true); await pending; assert.equal(f.opens.length, 0);
  }
});
test('disabled service and an active direct call preserve the current call', async () => {
  const f = fixture(); f.ready = async () => false; await assert.rejects(f.join(), /enable/); f.ready = async () => true; f.direct = { state: 'connected' }; await assert.rejects(f.join(), /Finish the direct call/); assert.equal(f.opens.length, 0);
});
