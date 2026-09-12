const lifetime = 15 * 60_000, limit = 128;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);

/** Recent handled invitations must not ring again when room history is replayed.
 * Store only opaque call IDs for this native account/device in this tab. */
export function createCallDismissals(owner: readonly [string, string, string], storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, now = Date.now) {
  const key = 'tavern.call-handled.v1:' + JSON.stringify(owner), handled = new Map<string, number>();
  const prune = () => { for (const [id, at] of handled) if (at > now() || now() - at >= lifetime) handled.delete(id); };
  try {
    const raw = storage?.getItem(key);
    if (raw && raw.length <= 50000) {
      const entries = JSON.parse(raw);
      if (Array.isArray(entries) && entries.length <= limit) for (const entry of entries) {
        if (Array.isArray(entry) && entry.length === 2 && identifier(entry[0]) && Number.isSafeInteger(entry[1])) handled.set(entry[0], entry[1]);
      }
    }
  } catch { /* Keep the in-memory guard if optional tab storage is unavailable. */ }
  prune();
  return {
    has(id: string) { prune(); return identifier(id) && handled.has(id); },
    remember(id: string) {
      if (!identifier(id)) return;
      prune(); handled.delete(id); handled.set(id, now());
      while (handled.size > limit) handled.delete(handled.keys().next().value!);
      try { storage?.setItem(key, JSON.stringify([...handled])); } catch { /* Do not interrupt hangup. */ }
    },
  };
}
