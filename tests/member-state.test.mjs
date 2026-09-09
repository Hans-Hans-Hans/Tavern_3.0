import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { memberStateKey: key, memberStateTarget: target, memberStateEvent: read } = loadTs('../lib/member-state.ts', {});

test('member keys round trip exact identities within the native UTF-8 limit without reserved sigils', () => {
  for (const user of ['@a:test', '@_a:test', '@A:test', '@a:[::1]', '@' + 'a'.repeat(249) + ':test', '@' + 'é'.repeat(124) + 'a:test', '@😀:test']) {
    assert.equal(target(key(user)), user); assert.equal(key(user)[0], '_');
    assert.equal(new TextEncoder().encode(key(user)).length, new TextEncoder().encode(user).length);
  }
  for (const user of ['@' + 'a'.repeat(250) + ':test', '@' + 'é'.repeat(125) + ':test', '@bad\ud800:test', '@bad\n:test', '@bad/path:test', '@:test', '@a:', '_a:test']) assert.throws(() => key(user));
  for (const value of ['@a:test', 'user:@a:test', '_', '__:']) assert.throws(() => target(value));
});

test('canonical presence supersedes legacy values even for explicit clears, malformed values and older timestamps', () => {
  const events = new Map(), room = { currentState: { getStateEvents: (type, key) => events.get(type + key) } };
  for (const kind of ['io.tavern.timeout', 'io.tavern.tempban', 'io.tavern.server.nickname']) {
    const legacy = { value: 'old', origin_server_ts: 1000 }; events.set(kind + '@a:test', legacy);
    assert.equal(read(room, kind, '@a:test'), legacy);
    for (const canonical of [{ until: 0 }, { name: null }, {}, { origin_server_ts: 1 }]) {
      events.set(kind + '_a:test', canonical); assert.equal(read(room, kind, '@a:test'), canonical);
    }
    assert.equal(read(room, kind, '@b:test'), null);
  }
});
