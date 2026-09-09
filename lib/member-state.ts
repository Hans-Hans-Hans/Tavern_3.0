/** Stable Matrix reserves @ state keys for self-authored events. */
export function memberStateKey(target: string): string {
  if (typeof target !== 'string' || !/^@[^:\s/\\?#\u0000-\u001f\u007f]+:[^\s/\\?#\u0000-\u001f\u007f]+$/u.test(target)
    || /[\uD800-\uDFFF]/u.test(target) || new TextEncoder().encode(target).length > 255) throw new Error('Choose a valid Matrix member ID.');
  return '_' + target.slice(1);
}
export function memberStateTarget(key: string): string {
  if (typeof key !== 'string' || !key.startsWith('_')) throw new Error('Invalid member state key.');
  const target = '@' + key.slice(1);
  if (memberStateKey(target) !== key) throw new Error('Invalid member state key.');
  return target;
}
/** Canonical presence wins, including explicit clears and malformed state. */
export function memberStateEvent(room: any, kind: string, target: string): any {
  let key: string;
  try { key = memberStateKey(target); } catch { return null; }
  return room?.currentState.getStateEvents(kind, key) ?? room?.currentState.getStateEvents(kind, target) ?? null;
}
