/** Essential dependencies share one response deadline. Provider timeouts still
 * bound any underlying operation that cannot be cancelled through its port. */
export function createDependencyReadinessProbe(
  probes: Readonly<{
    database(): Promise<unknown>;
    storage(): Promise<unknown>;
  }>,
): Readonly<{ check(): Promise<void> }> {
  return {
    async check() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([
            Promise.resolve().then(() => probes.database()),
            Promise.resolve().then(() => probes.storage()),
          ]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Dependencies not ready")),
              3_000,
            );
          }),
        ]);
      } catch {
        // No provider errors, connection details or object information escape.
        throw new Error("Dependencies not ready");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
