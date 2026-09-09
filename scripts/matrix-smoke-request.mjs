import { setTimeout } from 'node:timers/promises';

// Direct callers use explicitly retryable native GET/PUT probes; known-room
// joins, leaves and invitations use the membership-aware helpers below. Room
// creation with invitations is not retryable: it can fail after persistence.
// Network failures and other statuses are returned or thrown unchanged.
// Production rate limits stay enabled.
export async function matrixSmokeRequest(request, pause = setTimeout) {
  for (let attempt = 0; ; attempt++) {
    const response = await request();
    const delay = response.data?.retry_after_ms;
    if (response.status !== 429 || response.data?.errcode !== 'M_LIMIT_EXCEEDED' || attempt === 4
      || typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 30000) return response;
    await pause(Math.max(100, delay + 100));
  }
}

// Joining an explicitly chosen room has a known membership target. Check it
// again after a confirmed rate limit so a partially applied join is not replayed.
export async function matrixSmokeJoin(readMembership, join, pause = setTimeout) {
  return matrixSmokeRequest(async () => {
    const membership = await readMembership();
    if (membership.status === 200 && membership.data?.membership === 'join') return membership;
    if (![200, 403, 404].includes(membership.status)) return membership;
    return join();
  }, pause);
}

// A leave may persist before the response is rate limited. Confirm its native
// membership before replaying; a forbidden read alone does not prove departure.
export async function matrixSmokeLeave(readMembership, leave, pause = setTimeout) {
  return matrixSmokeRequest(async () => {
    const membership = await readMembership();
    if (membership.status === 200 && membership.data?.membership === 'leave') return membership;
    if (![200, 403, 404].includes(membership.status)) return membership;
    return leave();
  }, pause);
}

// This narrow fixture operation relies on pinned Synapse 1.160.0 create_room:
// the creation/general rate limits run before persistence; these initial events
// are emitted with ratelimit=False. Keep invitations as separate known-room
// operations, and do not generalize this to arbitrary creation hooks/config.
// https://github.com/element-hq/synapse/blob/v1.160.0/synapse/handlers/room.py
export async function matrixSmokeCreateFixture(create, configuration, pause = setTimeout) {
  const config = structuredClone(configuration);
  const allowed = new Set(['name', 'visibility', 'preset', 'creation_content', 'initial_state']);
  const initialTypes = new Set(['m.room.encryption', 'm.room.history_visibility', 'm.space.parent']);
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !allowed.has(key)) || typeof config.name !== 'string' || !config.name.startsWith('CI ')
    || config.visibility !== 'private' || config.preset !== 'private_chat'
    || config.creation_content?.['m.federate'] !== false
    || !Array.isArray(config.initial_state ?? [])
    || (config.initial_state ?? []).some(event => !event || !initialTypes.has(event.type))) {
    throw new Error('Retryable CI room creation requires an isolated private fixture without invitation side effects.');
  }
  return matrixSmokeRequest(() => create(structuredClone(config)), pause);
}

export async function matrixSmokeInvite(readMembership, invite, pause = setTimeout) {
  return matrixSmokeRequest(async () => {
    const membership = await readMembership();
    if (membership.status === 200 && ['invite', 'join'].includes(membership.data?.membership)) return membership;
    if (membership.status === 200 && membership.data?.membership !== 'leave') {
      throw new Error('The known CI invite target has unexpected native membership.');
    }
    if (membership.status !== 200 && !(membership.status === 404 && membership.data?.errcode === 'M_NOT_FOUND')) return membership;
    return invite();
  }, pause);
}
