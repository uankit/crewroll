/** One UI read in flight. Report a stall honestly without queuing more work. */
export function createObservedRead<T>(
  options: Readonly<{
    read(): Promise<T>;
    ready(value: T): void;
    failed(): void;
    active(): boolean;
    deadlineMs?: number;
  }>,
) {
  let disposed = false;
  let running = false;
  let again = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const refresh = async (): Promise<void> => {
    if (disposed || !options.active()) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    deadline = setTimeout(() => {
      if (!disposed) options.failed();
    }, options.deadlineMs ?? 10_000);
    try {
      const value = await options.read();
      if (!disposed) options.ready(value);
    } catch {
      if (!disposed) options.failed();
    } finally {
      clearTimeout(deadline);
      running = false;
      if (again && !disposed) {
        again = false;
        void refresh();
      }
    }
  };
  return Object.freeze({
    refresh,
    dispose() {
      disposed = true;
      clearTimeout(deadline);
    },
  });
}
