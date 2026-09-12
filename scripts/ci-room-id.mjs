// CI syntax is not locality: a domainless v12 hash must also pass the native
// creation proof below, in the caller's fresh fixture registry and fixed stack.
import assert from 'node:assert/strict';

const legacy = /^![^\s/\\?#:\x00-\x1f\x7f]{1,200}:chat\.example\.test$/;
const hashed = /^![A-Za-z0-9_-]{43}$/;
const markers = new Set(['io.tavern.ci_dm', 'io.tavern.ci_invitation_privacy', 'io.tavern.ci_system', 'io.tavern.ci_afk', 'io.tavern.ci_audio', 'io.tavern.ci_channel_admission', 'io.tavern.ci_room_removal', 'io.tavern.ci_games_workflow']);
export function isCiRoomId(value) {
  if (typeof value !== 'string') return false;
  if (legacy.test(value)) return true;
  if (!hashed.test(value)) return false;
  const bytes = Buffer.from(value.slice(1), 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value.slice(1);
}

export function assertCiRoomCreation({ id, events, creator, name, marker, runId, space }) {
  assert.ok(isCiRoomId(id), 'Only bounded native CI room identifiers are permitted.');
  assert.match(creator, /^@ci(?:admin|alice|inviter):chat\.example\.test$/);
  assert.ok(markers.has(marker)); assert.match(runId, /^[a-f0-9]{24}$/);
  assert.ok(typeof name === 'string' && name.startsWith('CI ') && name.length <= 255);
  assert.equal(typeof space, 'boolean');
  assert.ok(Array.isArray(events) && events.length <= 100, 'Inspect bounded native fixture state.');
  const unique = new Set();
  for (const event of events) {
    assert.ok(event && typeof event.type === 'string' && typeof event.state_key === 'string'
      && event.content && typeof event.content === 'object' && !Array.isArray(event.content));
    const key = JSON.stringify([event.type, event.state_key]); assert.ok(!unique.has(key)); unique.add(key);
  }
  const find = (type, key = '') => events.find(event => event.type === type && event.state_key === key);
  const create = find('m.room.create');
  assert.equal(create?.sender, creator, 'The fresh native create event must belong to the owning CI account.');
  assert.equal(create.content['m.federate'], false);
  assert.equal(create.content[marker], runId, 'Only this run\'s immutable creation marker is permitted.');
  assert.equal(create.content.type, space ? 'm.space' : undefined);
  assert.equal(create.content.additional_creators, undefined);
  if (create.room_id !== undefined) assert.equal(create.room_id, id);
  if (hashed.test(id)) assert.equal(create.content.room_version, '12', 'A domainless hash requires native v12 creation proof.');
  else assert.notEqual(create.content.room_version, '12', 'A native v12 room must use its domainless create-event hash.');
  assert.equal(find('m.room.name')?.content.name, name);
  assert.equal(find('m.room.member', creator)?.content.membership, 'join');
  return find;
}
