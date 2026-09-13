import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const original = { name: 'cheers', uri: 'mxc://local/original', creator: '@owner:local' };
function fixture() {
  const f = { account: {}, user: '@owner:local', device: 'D1', base: 'https://local', joined: true, allowed: true,
    emoji: [original], writes: [], uploads: 0, reads: 0, crop: null, upload: null, read: null, write: null };
  const room = { isSpaceRoom: () => true, getMyMembership: () => f.joined ? 'join' : 'leave', currentState: {
    maySendStateEvent: () => f.allowed, getStateEvents: () => ({ getContent: () => ({ emoji: f.emoji }) }),
  } };
  const client = { getUserId: () => f.user, getDeviceId: () => f.device, getHomeserverUrl: () => f.base,
    getRoom: () => room, getStateEvent: async () => { f.reads++; if (f.read) await f.read.promise; return { emoji: f.emoji }; },
    sendStateEvent: async (_room, _type, content) => { f.writes.push(content); if (f.write) await f.write.promise; f.emoji = content.emoji; },
  };
  f.client = client;
  f.api = loadTs('../lib/server-emoji.ts', {
    './api': { accountArtworkOwner: () => f.account }, './matrix': { getMatrixClient: () => f.client },
    './community': { cleanMxc: value => typeof value === 'string' && value.startsWith('mxc://') ? value : '',
      cropProfileImage: async () => { if (f.crop) await f.crop.promise; return new Blob(['image'], { type: 'image/webp' }); },
      uploadProfileImage: async () => { f.uploads++; if (f.upload) await f.upload.promise; return 'mxc://local/new'; },
    },
  });
  return f;
}
async function tick() { await new Promise(resolve => setImmediate(resolve)); }

for (const change of ['account', 'client', 'user', 'device', 'base', 'joined', 'allowed']) test('emoji crop cannot continue after ' + change + ' changes', async () => {
  const f = fixture(); f.crop = deferred();
  const result = assert.rejects(f.api.addServerEmoji('!server:local', 'new', {}), /no longer|permission/);
  if (change === 'account') f.account = {};
  else if (change === 'client') f.client = { ...f.client };
  else if (change === 'joined' || change === 'allowed') f[change] = false;
  else f[change] += '-changed';
  f.crop.resolve(); await result;
  assert.equal(f.uploads, 0); assert.equal(f.reads, 0); assert.equal(f.writes.length, 0);
});

test('an upload already sent never publishes emoji under a replacement account', async () => {
  const f = fixture(); f.upload = deferred();
  const result = assert.rejects(f.api.addServerEmoji('!server:local', 'new', {}), /no longer current/);
  await tick(); assert.equal(f.uploads, 1); f.account = {}; f.upload.resolve(); await result;
  assert.equal(f.reads, 0); assert.equal(f.writes.length, 0);
});

test('queued emoji edits recheck authority before reads and state writes', async () => {
  const f = fixture(); f.read = deferred();
  const first = assert.rejects(f.api.renameServerEmoji('!server:local', 'cheers', 'hello'), /permission/);
  await tick();
  const second = assert.rejects(f.api.removeServerEmoji('!server:local', 'cheers'), /permission/);
  f.allowed = false; f.read.resolve(); await Promise.all([first, second]);
  assert.equal(f.reads, 1); assert.equal(f.writes.length, 0);
});

test('closing the editor during a native read prevents the pending change', async () => {
  const f = fixture(); f.read = deferred(); let current = true;
  const result = assert.rejects(f.api.removeServerEmoji('!server:local', 'cheers', { isCurrent: () => current }), /no longer current/);
  await tick(); current = false; f.read.resolve(); await result; assert.equal(f.writes.length, 0);
});

test('acknowledged writes stay successful when the editor closes while saving', async () => {
  const f = fixture(); f.write = deferred(); let current = true;
  const result = f.api.renameServerEmoji('!server:local', 'cheers', 'hello', { isCurrent: () => current });
  await tick(); assert.equal(f.writes.length, 1); current = false; f.write.resolve(); await result;
  assert.equal(f.emoji[0].name, 'hello'); assert.deepEqual(f.emoji[0].aliases, ['cheers']);
});

test('rename and removal refuse a replaced image and preserve independent emoji', async () => {
  const f = fixture(); f.emoji = [{ ...original, uri: 'mxc://local/replacement' }, { ...original, name: 'other' }];
  for (const action of [() => f.api.removeServerEmoji('!server:local', 'cheers', { expectedUri: original.uri }),
    () => f.api.renameServerEmoji('!server:local', 'cheers', 'hello', { expectedUri: original.uri })]) {
    await assert.rejects(action(), /changed or was removed/);
  }
  assert.equal(f.writes.length, 0);
  await f.api.renameServerEmoji('!server:local', 'cheers', 'hello', { expectedUri: 'mxc://local/replacement' });
  await f.api.removeServerEmoji('!server:local', 'hello', { expectedUri: 'mxc://local/replacement' });
  assert.deepEqual(f.emoji.map(emoji => emoji.name), ['other']);
});

test('search finds previous names and fresh state rejects duplicate aliases', async () => {
  const f = fixture(); f.emoji = [{ ...original, aliases: ['celebrate'] }];
  assert.deepEqual(f.api.filterServerEmoji(f.emoji, ' :CELEBRATE: '), f.emoji);
  assert.deepEqual(f.api.filterServerEmoji(f.emoji, 'unknown'), []);
  await assert.rejects(f.api.addServerEmoji('!server:local', 'celebrate', {}), /already used/);
  assert.equal(f.uploads, 0);
  await f.api.addServerEmoji('!server:local', 'hello', {});
  assert.equal(f.emoji[1].creator, '@owner:local');
});
