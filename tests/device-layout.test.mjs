import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { compactDeviceLayout } = loadTs('../lib/device-layout.ts', {});
const desktop = { width: 1280, height: 800, userAgent: 'Desktop browser', coarsePointer: false };

test('narrow windows use compact navigation without requiring a phone user agent', () => {
  assert.equal(compactDeviceLayout({ ...desktop, width: 390 }), true);
  assert.equal(compactDeviceLayout(desktop), false);
});
test('phone hints preserve compact navigation when rotated to landscape', () => {
  for (const hint of [{ mobileHint: true }, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }, { userAgent: 'Mozilla/5.0 (Linux; Android 15) Mobile Safari/537.36' }, { coarsePointer: true }]) {
    assert.equal(compactDeviceLayout({ ...desktop, width: 844, height: 390, ...hint }), true);
  }
});
test('touch capability alone does not collapse roomy tablets or laptops', () => {
  assert.equal(compactDeviceLayout({ ...desktop, coarsePointer: true }), false);
  assert.equal(compactDeviceLayout({ ...desktop, width: 1024, height: 768, coarsePointer: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' }), false);
  assert.equal(compactDeviceLayout({ ...desktop, width: 1024, height: 768, coarsePointer: true, mobileHint: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' }), false);
  assert.equal(compactDeviceLayout({ ...desktop, width: 844, height: 390 }), false);
});
