import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { createThreadReplyRefresh } = loadTs('../lib/thread-reply-refresh.ts', {});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('newer thread replies win when history and sync projections resolve in reverse order', async () => {
  const first = deferred(), second = deferred(), queue = [first, second], visible = [];
  const reader = createThreadReplyRefresh(() => true, () => queue.shift().promise, value => visible.push(value));
  const older = reader.refresh(), newer = reader.refresh(); second.resolve(['latest']); await newer;
  first.resolve(['stale']); await older; assert.deepEqual(visible, [['latest']]);
});

test('cleanup invalidates reads even if the same thread scope is immediately reopened', async () => {
  const first = deferred(), second = deferred(), queue = [first, second], visible = []; let current = true;
  const reader = createThreadReplyRefresh(() => current, () => queue.shift().promise, value => visible.push(value));
  const older = reader.refresh(); current = false; reader.invalidate(); current = true;
  const newer = reader.refresh(); first.resolve(['closed view']); second.resolve(['reopened view']);
  await Promise.all([older, newer]); assert.deepEqual(visible, [['reopened view']]);
});

test('old scope failures stay silent and only the latest current failure remains retryable', async () => {
  const first = deferred(), second = deferred(), third = deferred(), queue = [first, second, third], visible = [];
  let current = true;
  const reader = createThreadReplyRefresh(() => current, () => queue.shift().promise, value => visible.push(value));
  const older = reader.refresh(), newer = reader.refresh(); first.reject(new Error('stale denial')); await older;
  second.reject(new Error('Current native denial')); await assert.rejects(newer, /Current native denial/);
  const gone = reader.refresh(); current = false; third.reject(new Error('old account')); await gone;
  await reader.refresh(); assert.deepEqual(visible, []); assert.equal(queue.length, 0);
});
