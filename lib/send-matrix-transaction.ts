import type { MatrixClient, Room } from 'matrix-js-sdk';

const withoutRelation = (content: Record<string, any>) => { const copy = { ...content }; delete copy['m.relates_to']; return copy; };
const acknowledgement = (value: unknown): { event_id: string } => {
  const id=(value as any)?.event_id;
  if(typeof id!=='string'||id.length<2||id.length>1024||!id.startsWith('$')||/[\s\u0000-\u001f\u007f]/.test(id))throw new Error('The homeserver returned an invalid message acknowledgement. Its original transaction is kept; check the conversation before retrying.');
  return {event_id:id};
};
/** Keep the SDK's local echo, encryption and native transaction identity.
 * sendMessage(txn) cannot be called twice while its local echo is registered. */
export async function sendMatrixTransaction(client: MatrixClient, room: Room, content: Record<string, any>, transactionId: string, parent: string | undefined, current: () => boolean) {
  if (!current()) throw new Error('Your account or conversation changed. Your draft is kept.');
  const previous = room.getEventForTxnId?.(transactionId);
  let result: { event_id: string };
  if (previous) {
    const relation = previous.getContent()['m.relates_to'];
    if (previous.getRoomId() !== room.roomId || previous.getSender() !== client.getUserId() || previous.getTxnId() !== transactionId
      || (parent ? relation?.rel_type !== 'm.thread' || relation.event_id !== parent : !!relation)
      || JSON.stringify(withoutRelation(previous.getContent())) !== JSON.stringify(withoutRelation(content))) throw new Error('This transaction already belongs to another message. Keep its original content and check the conversation before replacing it.');
    if (previous.status === 'sent') return acknowledgement({event_id:previous.getId()});
    if (previous.status !== 'not_sent') throw new Error('This message is still being sent. Wait for its acknowledgement before retrying.');
    result = await client.resendEvent(previous, room);
  } else if (parent) result = await client.sendMessage(room.roomId, parent, structuredClone(content) as any, transactionId);
  else result = await client.sendMessage(room.roomId, structuredClone(content) as any, transactionId);
  if (!current()) throw new Error('Your account or conversation changed after sending. Reopen the conversation.');
  return acknowledgement(result);
}
