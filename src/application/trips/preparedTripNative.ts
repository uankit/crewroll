import type { ActiveTripNativePort } from "./ports";

/** Per-session confirmation, not a persisted claim of native readiness.
 * Polling may return new trip/member data without re-importing keys or restarting
 * transfer lanes. Only successful commands are remembered; failures stay visible.
 */
export function createPreparedTripNative(
  native: ActiveTripNativePort,
): ActiveTripNativePort {
  let tail = Promise.resolve();
  const confirmed = new Map<string, string>();
  const run = <T>(name: string, command: T, operation: () => Promise<void>) => {
    const key = JSON.stringify(command);
    const result = tail.then(async () => {
      if (confirmed.get(name) === key) return;
      confirmed.delete(name);
      await operation();
      confirmed.set(name, key);
    });
    // A failed command rejects its caller but must not poison later attempts.
    tail = result.catch(() => undefined);
    return result;
  };
  return Object.freeze({
    importTripKey: (
      command: Parameters<ActiveTripNativePort["importTripKey"]>[0],
    ) => run("import", command, () => native.importTripKey(command)),
    activateTrip: (
      command: Parameters<ActiveTripNativePort["activateTrip"]>[0],
    ) => run("activate", command, () => native.activateTrip(command)),
  });
}
