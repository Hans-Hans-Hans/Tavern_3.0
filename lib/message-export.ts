import { Direction, type MatrixClient } from 'matrix-js-sdk';
import { getMatrixClient } from './matrix';
export type ExportProgress = { room: string; roomsDone: number; roomsTotal: number; examined: number; exported: number; undecryptable: number };
export async function exportMessageHistory(client: MatrixClient, roomIds: string[], ownOnly: boolean, write: (line: string) => Promise<void>, onProgress: (value: ExportProgress) => void, signal: AbortSignal) {
  const started = Date.now(), userId = client.getUserId(), progress: ExportProgress = { room: '', roomsDone: 0, roomsTotal: roomIds.length, examined: 0, exported: 0, undecryptable: 0 };
  const check = () => { signal.throwIfAborted(); if (client !== getMatrixClient()) throw new Error('Your account changed. The export was stopped.'); };
  check(); await write(JSON.stringify({ type: 'manifest', version: 1, exportedAt: new Date(started).toISOString(), userId, scope: ownOnly ? 'Messages you sent in selected joined rooms' : 'Readable message events in selected joined rooms', format: 'JSON Lines; edits, reactions and redactions retain their event relations', encrypted: false }) + '\n');
  for (const roomId of [...new Set(roomIds)]) {
    check(); const room = client.getRoom(roomId); if (!room || room.getMyMembership() !== 'join') throw new Error('You no longer belong to one of the selected rooms.');
    progress.room = room.name || roomId; let token: string | null = null; const seen = new Set<string>();
    await write(JSON.stringify({ type: 'room', roomId, name: room.name, encrypted: room.hasEncryptionStateEvent() }) + '\n');
    while (true) {
      check(); const page = await client.createMessagesRequest(roomId, token, 100, Direction.Backward); check();
      if (!Array.isArray(page.chunk)) throw new Error('The homeserver returned an invalid history page.');
      for (const raw of page.chunk) {
        check(); progress.examined++;
        if (raw.origin_server_ts > started || (ownOnly && raw.sender !== userId)) continue;
        const event = client.getEventMapper()({ ...raw, room_id: roomId });
        if (event.isEncrypted()) { await client.decryptEventIfNeeded(event).catch(() => {}); check(); }
        if (event.isDecryptionFailure()) { progress.undecryptable++; await write(JSON.stringify({ type: 'undecryptable', roomId, eventId: raw.event_id, sender: raw.sender, timestamp: raw.origin_server_ts }) + '\n'); continue; }
        if (!['m.room.message', 'm.reaction', 'm.room.redaction'].includes(event.getType())) continue;
        await write(JSON.stringify({ type: 'event', roomId, eventId: event.getId(), eventType: event.getType(), sender: event.getSender(), timestamp: event.getTs(), redacted: event.isRedacted(), redacts: (raw as {redacts?:string}).redacts, content: event.isRedacted() ? {} : event.getOriginalContent() }) + '\n'); progress.exported++;
      }
      onProgress({ ...progress });
      if (!page.chunk.length || !page.end) break;
      if (page.end === token || seen.has(page.end)) throw new Error('History pagination stopped advancing. Retry the export after checking your homeserver.');
      seen.add(page.end); token = page.end;
    }
    progress.roomsDone++; onProgress({ ...progress });
  }
  check(); await write(JSON.stringify({ type: 'complete', ...progress, completedAt: new Date().toISOString() }) + '\n'); return progress;
}
