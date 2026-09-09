import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { normalizeAppearance, resolvedTheme, desaturateColor } = loadTs('../lib/appearance.ts', { './matrix': {}, './api': {}, 'matrix-js-sdk': { ClientEvent: {} } });
test('appearance settings bound scaling, reject invalid values, and follow system by default', () => { const p = normalizeAppearance({ theme: 'fake', font: 'url(tracker)', chatScale: 1000, saturation: -10, reducedMotion: false }); assert.equal(p.theme, 'system'); assert.equal(p.font, 'system'); assert.equal(p.chatScale, 1.5); assert.equal(p.saturation, 0); assert.equal(p.memberList, true); assert.equal(p.reducedMotion, 'system'); assert.equal(normalizeAppearance({ chatScale: NaN }).chatScale, 1); });
test('system theme follows OS without overwriting explicit theme', () => { assert.equal(resolvedTheme('system', true), 'dark'); assert.equal(resolvedTheme('system', false), 'light'); assert.equal(resolvedTheme('light', true), 'light'); assert.equal(resolvedTheme('dark', false), 'dark'); });
test('saturation preserves luminance and alpha and leaves unsupported colors untouched', () => { assert.equal(desaturateColor('rgb(100, 150, 200)', 1), 'rgba(100, 150, 200, 1)'); assert.equal(desaturateColor('rgba(100, 150, 200, 0.5)', 0), 'rgba(143, 143, 143, 0.5)'); assert.equal(desaturateColor('oklch(1 0 0)', 0), 'oklch(1 0 0)'); });

test('density and message spacing preserve legacy compact behavior until explicitly selected', () => {
  assert.equal(normalizeAppearance({ compact: true }).messageSpacing, 'auto');
  assert.equal(normalizeAppearance({}).density, 'comfortable');
  assert.equal(normalizeAppearance({ density: 'compact', messageSpacing: 'spacious' }).messageSpacing, 'spacious');
  assert.equal(normalizeAppearance({ density: 'invalid', messageSpacing: '<script>' }).messageSpacing, 'auto');
});

function savingFixture() {
  let account = {}, record = { version: 1, theme: 'dark', memberList: false }, writes = 0;
  const client = { getUserId: () => '@alice:local', getDeviceId: () => 'A', getAccountData: () => ({ getContent: () => record }),
    getAccountDataFromServer: async () => record, setAccountData: async (_key, value) => { writes++; record = value; } };
  let current = client;
  const api = loadTs('../lib/appearance.ts', { './matrix': { getMatrixClient: () => current }, './api': { accountArtworkOwner: () => account }, 'matrix-js-sdk': { ClientEvent: {} } });
  return { api, client, record: () => record, writes: () => writes, changeAccount: () => { account = {}; }, replaceClient: () => { current = { ...client }; } };
}
test('serialized appearance changes merge fresh server preferences without losing other choices', async () => {
  const f = savingFixture();
  await Promise.all([f.api.saveAppearance({ density: 'compact' }), f.api.saveAppearance({ messageSpacing: 'spacious' })]);
  assert.equal(f.record().theme, 'dark'); assert.equal(f.record().memberList, false);
  assert.equal(f.record().density, 'compact'); assert.equal(f.record().messageSpacing, 'spacious');
});
for (const boundary of ['changeAccount', 'replaceClient']) test('a delayed settings read cannot write after ' + boundary, async () => {
  const f = savingFixture(); let finish;
  f.client.getAccountDataFromServer = () => new Promise(resolve => { finish = resolve; });
  const saving = f.api.saveAppearance({ density: 'compact' });
  while (!finish) await Promise.resolve();
  f[boundary](); finish(f.record());
  await assert.rejects(saving, /account changed/); assert.equal(f.writes(), 0);
});
test('a delayed settings acknowledgement cannot publish into a replacement account', async () => {
  const f = savingFixture(); let finish;
  f.client.setAccountData = () => new Promise(resolve => { finish = resolve; });
  const saving = f.api.saveAppearance({ density: 'compact' });
  while (!finish) await Promise.resolve();
  f.changeAccount(); finish(); await assert.rejects(saving, /account changed/);
});
