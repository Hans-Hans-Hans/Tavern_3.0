/** Project events only while their original account and joined Room still own the read. */
export async function readJoinedRoom<T, R>(client: any, room: any, current: () => boolean, read: () => Promise<T>, project: (value: T) => R): Promise<R> {
  const check = () => {
    if (!current() || !room || client.getRoom(room.roomId) !== room || room.getMyMembership() !== 'join') throw new Error('Your account or room access changed. Reopen the conversation.');
  };
  check();
  const result = await read();
  check();
  return project(result);
}
