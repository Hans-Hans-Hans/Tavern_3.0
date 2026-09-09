/** Recognize the immutable room type even if its binding is unavailable. */
export function isPrivateDiscussion(room: any): boolean {
  return room?.currentState.getStateEvents('m.room.create', '')?.getContent()?.type === 'io.tavern.private_thread';
}
