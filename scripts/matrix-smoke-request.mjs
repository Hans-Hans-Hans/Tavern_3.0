import { setTimeout } from 'node:timers/promises';

// Used only for explicitly retryable native GET/PUT probes. Never wrap room
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
