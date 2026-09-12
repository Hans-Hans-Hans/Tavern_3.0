export const CALL_TELEMETRY_TYPE = 'io.tavern.call.telemetry';
export const CALL_TELEMETRY_READY = 'io.tavern.call.telemetry.ready';
export const CALL_TELEMETRY_BIND = 'io.tavern.call.telemetry.bind';
export const CALL_AUDIO_SET = 'io.tavern.call.audio.set';
export const CALL_AUDIO_ACK = 'io.tavern.call.audio.ack';
export const TELEMETRY_LIMIT = 128;
export const CONFERENCE_FAILURE_CODES = ['MISSING_MATRIX_RTC_TRANSPORT', 'CONNECTION_LOST_ERROR', 'INTERNAL_MEMBERSHIP_MANAGER', 'FAILED_TO_START_LIVEKIT', 'INSUFFICIENT_CAPACITY_ERROR', 'E2EE_NOT_SUPPORTED', 'STICKY_EVENTS_NOT_SUPPORTED', 'OPEN_ID_ERROR', 'NO_MATRIX_2_0_AUTHORIZATION_SERVICE', 'SFU_ERROR', 'UNKNOWN_ERROR'] as const;
const failureCauses = ['MatrixError', 'ConnectionError', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AbortError', 'Error', 'unknown'] as const;
const failureReasons = ['NotAllowed', 'ServerUnreachable', 'InternalError', 'Cancelled', 'LeaveRequest', 'Timeout', 'WebSocket', 'ServiceNotFound'] as const;
const failureMatrixCodes = ['M_FORBIDDEN', 'M_UNKNOWN_TOKEN', 'M_MISSING_TOKEN', 'M_NOT_FOUND', 'M_UNRECOGNIZED', 'M_LIMIT_EXCEEDED', 'M_UNKNOWN', 'M_BAD_JSON', 'M_NOT_JSON', 'M_UNAUTHORIZED', 'M_INVALID_PARAM', 'M_RESOURCE_LIMIT_EXCEEDED', 'M_UNSUPPORTED_ROOM_VERSION', 'M_INCOMPATIBLE_ROOM_VERSION'] as const;
const failureStatuses = [400, 401, 403, 404, 408, 409, 410, 413, 429, 500, 502, 503, 504] as const;
export type ConferenceFailure = { code: typeof CONFERENCE_FAILURE_CODES[number]; cause: typeof failureCauses[number] | null; status: typeof failureStatuses[number] | null; reason: typeof failureReasons[number] | null; matrixCode: typeof failureMatrixCodes[number] | null };
export type ConferenceParticipant = {
  identity: string; userId: string; deviceId: string; displayName: string; avatarMxc: string | null;
  local: boolean; speaking: boolean; microphoneEnabled: boolean; cameraEnabled: boolean; screenShareEnabled: boolean;
  e2eeEnabled: boolean | null; encrypted: boolean | null;
};
export type ConferenceMetrics = { rttMs: number | null; jitterMs: number | null; packetLossPercent: number | null; sampledTracks: number; totalTracks: number };
export type ConferenceTelemetry = { connected: boolean; reconnecting: boolean; participants: ConferenceParticipant[]; complete: boolean; e2eeEnabled: boolean | null; metrics: ConferenceMetrics; failure?: ConferenceFailure | null; deafened?: boolean | null };
export type ConferenceTelemetryMessage = ConferenceTelemetry & { type: typeof CALL_TELEMETRY_TYPE; version: 1; widgetId: string; session: string; roomId: string; document: string; sequence: number };
export const emptyConferenceMetrics = (): ConferenceMetrics => ({ rttMs: null, jitterMs: null, packetLossPercent: null, sampledTracks: 0, totalTracks: 0 });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name));
export const telemetryString = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export const telemetryNonce = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{20,80}$/.test(v);
const boolOrNull = (v: unknown) => v === null || typeof v === 'boolean';
const numberOrNull = (v: unknown, max: number) => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const allowed = <T extends string | number>(values: readonly T[], value: unknown): value is T => values.includes(value as T);
function parseFailure(value: unknown): ConferenceFailure | null {
  if (!record(value) || !keys(value, ['code', 'cause', 'status', 'reason', 'matrixCode']) || !allowed(CONFERENCE_FAILURE_CODES, value.code) ||
      value.cause !== null && !allowed(failureCauses, value.cause) || value.status !== null && !allowed(failureStatuses, value.status) ||
      value.reason !== null && !allowed(failureReasons, value.reason) || value.matrixCode !== null && !allowed(failureMatrixCodes, value.matrixCode)) return null;
  return { code: value.code, cause: value.cause, status: value.status, reason: value.reason, matrixCode: value.matrixCode } as ConferenceFailure;
}
/** Only typed categories are projected. Never return Error.message, stack,
 * arbitrary errcodes, localized text, request details or transport URLs. */
export function conferenceFailure(error: unknown): ConferenceFailure {
  const failure: ConferenceFailure = { code: 'UNKNOWN_ERROR', cause: null, status: null, reason: null, matrixCode: null };
  if (!record(error)) { failure.cause = 'unknown'; return failure; }
  if (allowed(CONFERENCE_FAILURE_CODES, error.code)) failure.code = error.code;
  // Pinned LivekitConnectionError keeps reasonName here, without retaining cause.
  if (record(error.localisedMessageValues) && allowed(failureReasons, error.localisedMessageValues.reason)) failure.reason = error.localisedMessageValues.reason;
  let cause: unknown = error.cause;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && record(cause) && !seen.has(cause); depth++, cause = cause.cause) {
    seen.add(cause);
    if (allowed(failureMatrixCodes, cause.errcode)) { failure.matrixCode ??= cause.errcode; failure.cause = 'MatrixError'; }
    if (allowed(failureReasons, cause.reasonName)) { failure.reason ??= cause.reasonName; if (!failure.matrixCode) failure.cause = 'ConnectionError'; }
    if (failure.cause === null || failure.cause === 'Error' || failure.cause === 'unknown') failure.cause = allowed(failureCauses, cause.name) ? cause.name : 'unknown';
    const status = cause.httpStatus ?? cause.status;
    if (allowed(failureStatuses, status)) failure.status ??= status;
  }
  return failure;
}
export function parseConferenceTelemetry(value: unknown): ConferenceTelemetryMessage | null {
  if (!record(value) || !keys(value, ['type', 'version', 'widgetId', 'session', 'roomId', 'document', 'sequence', 'connected', 'reconnecting', 'participants', 'complete', 'e2eeEnabled', 'metrics', ...(Object.hasOwn(value, 'failure') ? ['failure'] : []), ...(Object.hasOwn(value, 'deafened') ? ['deafened'] : [])]) ||
      value.type !== CALL_TELEMETRY_TYPE || value.version !== 1 || !telemetryNonce(value.widgetId) || !telemetryNonce(value.session) || !telemetryNonce(value.document) ||
      !telemetryString(value.roomId, 255) || !value.roomId.startsWith('!') || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 ||
      typeof value.connected !== 'boolean' || typeof value.reconnecting !== 'boolean' || typeof value.complete !== 'boolean' || !boolOrNull(value.e2eeEnabled) ||
      !Array.isArray(value.participants) || value.participants.length > TELEMETRY_LIMIT || value.deafened !== undefined && !boolOrNull(value.deafened)) return null;
  const failure = value.failure === undefined || value.failure === null ? null : parseFailure(value.failure);
  if (value.failure !== undefined && value.failure !== null && !failure) return null;
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
  return { ...value, participants: value.participants.map(p => ({ ...p })), metrics: { ...m }, failure } as ConferenceTelemetryMessage;
}
