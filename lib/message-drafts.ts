/** Navigation drafts stay in memory and belong to one exact browser identity. */
export type DraftOwner = { client: object; account: object; userId: string; deviceId: string };
export type MessageDraft = Readonly<{ text: string; revision: number }>;
const empty: MessageDraft = Object.freeze({ text: '', revision: 0 });
const sameOwner = (a: DraftOwner | null, b: DraftOwner | null) => a === b || !!a && !!b
  && a.client === b.client && a.account === b.account && a.userId === b.userId && a.deviceId === b.deviceId;
const key = (roomId: string, parent = '') => JSON.stringify([roomId, parent]);

export function createMessageDraftStore(currentOwner: () => DraftOwner | null) {
  let owner: DraftOwner | null = null, revision = 0, retirementQueued = false;
  const entries = new Map<string, MessageDraft>(), listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  function synchronize() {
    const current = currentOwner();
    if (sameOwner(owner, current)) return false;
    owner = current ? Object.freeze({ ...current }) : null;
    entries.clear();
    // A late callback can observe retirement before the Matrix/UI event does.
    // Defer notification so reads during React render never update siblings.
    if (listeners.size && !retirementQueued) {
      retirementQueued = true;
      queueMicrotask(() => { retirementQueued = false; notify(); });
    }
    return true;
  }
  function isCurrent(expected: DraftOwner | null) {
    synchronize();
    return expected !== null && owner === expected;
  }
  return {
    // Reads may retire an old identity but never notify React while rendering.
    owner() { synchronize(); return owner; },
    isCurrent,
    refresh() { synchronize(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    read(expected: DraftOwner | null, roomId: string, parent = '') {
      return isCurrent(expected) ? entries.get(key(roomId, parent)) || empty : empty;
    },
    write(expected: DraftOwner | null, roomId: string, parent: string | undefined, text: string) {
      if (!isCurrent(expected)) return false;
      const id = key(roomId, parent), previous = entries.get(id);
      if (previous?.text === text || !previous && !text) return true;
      if (text) entries.set(id, Object.freeze({ text, revision: ++revision })); else entries.delete(id);
      notify(); return true;
    },
    clear(expected: DraftOwner | null, roomId: string, parent: string | undefined, acknowledged: MessageDraft) {
      if (!isCurrent(expected)) return false;
      const id = key(roomId, parent);
      if ((entries.get(id) || empty) !== acknowledged) return false;
      if (entries.delete(id)) notify();
      return true;
    },
  };
}
