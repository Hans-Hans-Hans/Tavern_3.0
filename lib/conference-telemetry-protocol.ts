export const CALL_TELEMETRY_TYPE = 'io.tavern.call.telemetry';
export const TELEMETRY_LIMIT = 128;
export type ConferenceParticipant = {
  identity: string; userId: string; deviceId: string; displayName: string; avatarMxc: string | null;
  local: boolean; speaking: boolean; microphoneEnabled: boolean; cameraEnabled: boolean; screenShareEnabled: boolean;
  e2eeEnabled: boolean | null; encrypted: boolean | null;
};
export type ConferenceMetrics = { rttMs: number | null; jitterMs: number | null; packetLossPercent: number | null; sampledTracks: number; totalTracks: number };
export type ConferenceTelemetry = { connected: boolean; reconnecting: boolean; participants: ConferenceParticipant[]; complete: boolean; e2eeEnabled: boolean | null; metrics: ConferenceMetrics };
export type ConferenceTelemetryMessage = ConferenceTelemetry & { type: typeof CALL_TELEMETRY_TYPE; version: 1; widgetId: string; session: string; roomId: string; sequence: number };
export const emptyConferenceMetrics = (): ConferenceMetrics => ({ rttMs: null, jitterMs: null, packetLossPercent: null, sampledTracks: 0, totalTracks: 0 });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name));
export const telemetryString = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export const telemetryNonce = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{20,80}$/.test(v);
const boolOrNull = (v: unknown) => v === null || typeof v === 'boolean';
const numberOrNull = (v: unknown, max: number) => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
export function parseConferenceTelemetry(value: unknown): ConferenceTelemetryMessage | null {
  if (!record(value) || !keys(value, ['type', 'version', 'widgetId', 'session', 'roomId', 'sequence', 'connected', 'reconnecting', 'participants', 'complete', 'e2eeEnabled', 'metrics']) ||
      value.type !== CALL_TELEMETRY_TYPE || value.version !== 1 || !telemetryNonce(value.widgetId) || !telemetryNonce(value.session) ||
      !telemetryString(value.roomId, 255) || !value.roomId.startsWith('!') || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 ||
      typeof value.connected !== 'boolean' || typeof value.reconnecting !== 'boolean' || typeof value.complete !== 'boolean' || !boolOrNull(value.e2eeEnabled) ||
      !Array.isArray(value.participants) || value.participants.length > TELEMETRY_LIMIT) return null;
  const identities = new Set<string>();
  for (const participant of value.participants) {
    if (!record(participant) || !keys(participant, ['identity', 'userId', 'deviceId', 'displayName', 'avatarMxc', 'local', 'speaking', 'microphoneEnabled', 'cameraEnabled', 'screenShareEnabled', 'e2eeEnabled', 'encrypted']) ||
        !telemetryString(participant.identity) || identities.has(participant.identity) || !telemetryString(participant.userId, 255) || !/^@[^\s:]+:[^\s]+$/.test(participant.userId) ||
        !telemetryString(participant.deviceId, 255) || !telemetryString(participant.displayName, 160) ||
        participant.avatarMxc !== null && (!telemetryString(participant.avatarMxc, 2048) || !/^mxc:\/\/[^\s/?#]+\/[^\s/?#]+$/.test(participant.avatarMxc)) ||
        !['local', 'speaking', 'microphoneEnabled', 'cameraEnabled', 'screenShareEnabled'].every(key => typeof participant[key] === 'boolean') || !boolOrNull(participant.e2eeEnabled) || !boolOrNull(participant.encrypted)) return null;
    identities.add(participant.identity);
  }
  const m = value.metrics;
  if (!record(m) || !keys(m, ['rttMs', 'jitterMs', 'packetLossPercent', 'sampledTracks', 'totalTracks']) ||
      !numberOrNull(m.rttMs, 120_000) || !numberOrNull(m.jitterMs, 120_000) || !numberOrNull(m.packetLossPercent, 100) ||
      !Number.isSafeInteger(m.sampledTracks) || (m.sampledTracks as number) < 0 || (m.sampledTracks as number) > 8 ||
      !Number.isSafeInteger(m.totalTracks) || (m.totalTracks as number) < (m.sampledTracks as number) || (m.totalTracks as number) > TELEMETRY_LIMIT) return null;
  // Detached primitive-only data; callers cannot retain the event's mutable object.
  return { ...value, participants: value.participants.map(p => ({ ...p })), metrics: { ...m } } as ConferenceTelemetryMessage;
}
