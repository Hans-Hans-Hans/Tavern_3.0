/** Only the newest read for the current thread view may publish a projection.
 * Invalidate on cleanup as well as navigation: a late read must not revive a
 * closed view, including when the same account/thread is reopened. */
export function createThreadReplyRefresh<T>(current: () => boolean, read: () => Promise<T>, publish: (value: T) => void) {
  let request = 0;
  return {
    invalidate() { request++; },
    async refresh() {
      const captured = ++request;
      if (!current()) return;
      try {
        const value = await read();
        if (captured === request && current()) publish(value);
      } catch (error) {
        if (captured === request && current()) throw error;
      }
    },
  };
}
