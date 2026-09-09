import { getMatrixClient } from './matrix';
import { roomContext } from './channel-policy';
import { effectiveRolePermissions } from './roles';
export type BulkRedactionResult = { redacted: string[]; failures: { id: string; message: string }[]; remaining: string[]; cancelled: boolean };
export function canBulkRedact(roomId: string) {
  try { const { room, me, policies, unknownPolicy } = roomContext(roomId); return !unknownPolicy && room.currentState.hasSufficientPowerLevelFor('redact', room.getMember(me)?.powerLevel || 0) && room.currentState.maySendEvent('m.room.redaction', me) && policies.every(policy => effectiveRolePermissions(policy, me, roomId).has('manage_messages')); } catch { return false; }
}
export async function bulkRedactMessages(roomId: string, eventIds: string[], reason: string, options: { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void } = {}): Promise<BulkRedactionResult> {
  const client = getMatrixClient(), ids = [...new Set(eventIds)];
  if (!client || !canBulkRedact(roomId)) throw new Error('You need permission to moderate messages in this conversation.');
  if (!ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string' || !/^\$[^\s]{1,1023}$/.test(id))) throw new Error('Choose between 1 and 50 valid messages.');
  if (!reason.trim() || reason.length > 500) throw new Error('Provide a moderation reason of 1 to 500 characters.');
  const result: BulkRedactionResult = { redacted: [], failures: [], remaining: [], cancelled: false }, batch = crypto.randomUUID();
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    if (options.signal?.aborted) { result.cancelled = true; result.remaining = ids.slice(index); break; }
    if (client !== getMatrixClient() || !canBulkRedact(roomId)) { result.failures.push({ id, message: 'Your account or moderation permission changed. Remaining messages were not submitted.' }); result.remaining = ids.slice(index); break; }
    try {
      // Re-fetch the event through the authenticated homeserver, rather than trusting a selection's sender or type.
      const raw = await client.fetchRoomEvent(roomId, id);
      if (raw.event_id !== id || raw.room_id && raw.room_id !== roomId || raw.state_key !== undefined || typeof raw.type !== 'string' || !['m.room.message', 'm.room.encrypted'].includes(raw.type)) throw new Error('This event is not a message in the selected conversation.');
      if (client !== getMatrixClient() || !canBulkRedact(roomId)) throw new Error('Your account or moderation permission changed.');
      if (!raw.unsigned?.redacted_because) await client.redactEvent(roomId, id, 'tavern.bulk.' + batch + '.' + index, { reason: reason.trim() });
      result.redacted.push(id);
    } catch (error) {
      const failure = error as { message?: string; httpStatus?: number; errcode?: string };
      result.failures.push({ id, message: failure.message || 'Redaction was not confirmed. Reload the conversation before retrying.' });
      if (failure.httpStatus === 401 || failure.httpStatus === 403 || failure.errcode === 'M_FORBIDDEN' || failure.errcode === 'M_UNKNOWN_TOKEN') { result.remaining = ids.slice(index + 1); break; }
    }
    options.onProgress?.(index + 1, ids.length);
  }
  return result;
}
