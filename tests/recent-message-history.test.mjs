import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, Room, MatrixEvent, Direction } from 'matrix-js-sdk';
import { loadTs } from './load-ts.mjs';
const { recentMessageHistory } = loadTs('../lib/recent-message-history.ts', { 'matrix-js-sdk': { Direction } });
function fixture() {
  const client = createClient({ baseUrl: 'https://local', userId: '@alice:local', deviceId: 'ONE' }), room = new Room('!dm:local', client, '@alice:local', {});
  room.updateMyMembership('join'); client.getRoom = () => room;
  const timeline = room.getLiveTimeline(); timeline.setPaginationToken('page-0', Direction.Backward);
  let messages = [], reads = 0, current = true;
  const read = async () => messages;
  const add = (type, id) => { const event = new MatrixEvent({ type, event_id: id, sender: '@bob:local', room_id: room.roomId, content: { body: 'Retained message' } }); if (type === 'm.room.message') messages.push(event); };
  client.scrollback = async () => { reads++; timeline.setPaginationToken('page-' + reads, Direction.Backward); if (reads === 2) add('m.room.message', '$retained'); return room; };
  return { client, room, timeline, read, add, count: () => reads, current: () => current, retire: () => { current = false; } };
}
test('a selected conversation finds retained messages beyond a control-only initial window and coalesces simultaneous refreshes', async () => {
  const f = fixture();
  const values = await Promise.all([recentMessageHistory(f.client,f.room,f.current,f.read),recentMessageHistory(f.client,f.room,f.current,f.read)]);
  assert.equal(f.count(),2); assert.equal(values[0][0].getId(),'$retained'); assert.equal(values[1][0].getId(),'$retained');
  await recentMessageHistory(f.client,f.room,f.current,f.read); assert.equal(f.count(),2);
});
test('empty history is bounded across subsequent sync updates and never loops over a repeated cursor', async () => {
  for (const repeated of [false,true]) {
    const f = fixture(); let reads = 0;
    f.client.scrollback = async () => { reads++; if (!repeated) f.timeline.setPaginationToken('empty-' + reads,Direction.Backward); return f.room; };
    for (let i=0;i<4;i++) assert.deepEqual(await recentMessageHistory(f.client,f.room,f.current,f.read),[]);
    assert.equal(reads,repeated?1:3);
  }
});
test('available content including an undecryptable placeholder needs no extra pagination, and departed/retired readers cannot publish', async () => {
  const existing = fixture(); assert.deepEqual(await recentMessageHistory(existing.client,existing.room,existing.current,async()=>['locked message']),['locked message']); assert.equal(existing.count(),0);
  for (const change of ['account','room']) {
    const f = fixture(); let release;
    f.client.scrollback = () => new Promise(resolve=>{release=()=>resolve(f.room);});
    const pending = recentMessageHistory(f.client,f.room,f.current,f.read);
    while (!release) await new Promise(resolve=>setImmediate(resolve));
    if(change==='account')f.retire();else f.room.updateMyMembership('leave');
    release(); await assert.rejects(pending,/changed/);
  }
});
