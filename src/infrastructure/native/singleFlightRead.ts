/** Coalesce overlapping reads, including retries after a UI deadline. A deadline
 * does not cancel a native call, so it must never release this in-flight slot.
 */
export function createSingleFlightRead<T>() {
  const pending = new Map<string, Promise<T>>();
  return Object.freeze({
    invalidate() {
      pending.clear();
    },
    read(key: string, operation: () => Promise<T>): Promise<T> {
      const existing = pending.get(key);
      if (existing) return existing;
      const result = Promise.resolve().then(operation);
      pending.set(key, result);
      const clear = () => {
        if (pending.get(key) === result) pending.delete(key);
      };
      void result.then(clear, clear);
      return result;
    },
  });
}
