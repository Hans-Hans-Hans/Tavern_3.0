import { setTimeout } from 'node:timers/promises';

// Direct callers use explicitly retryable native GET/PUT probes; known-room
// joins use the membership-aware helper below. Never wrap room
// creation: an invitation can be rate-limited after the room already exists.
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
