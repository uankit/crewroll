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
      confirmed.delete("album");
      confirmed.delete(name);
      await operation();
      confirmed.set(name, key);
    });
    // A failed command rejects its caller but must not poison later attempts.
    tail = result.catch(() => undefined);
    return result;
  };
  return Object.freeze({
    get importAndActivateTripWithAlbum() {
      const operation = native.importAndActivateTripWithAlbum;
      if (operation === undefined) return undefined;
      return (
        command: Parameters<
          NonNullable<ActiveTripNativePort["importAndActivateTripWithAlbum"]>
        >[0],
      ) => {
        const imported = JSON.stringify(command.envelope);
        const activated = JSON.stringify(command.activation);
        const album = JSON.stringify(command.album);
        const result = tail.then(async () => {
          if (
            confirmed.get("import") === imported &&
            confirmed.get("activate") === activated &&
            confirmed.get("album") === album
          )
            return;
          confirmed.delete("album");
          confirmed.delete("import");
          confirmed.delete("activate");
          await operation.call(native, command);
          confirmed.set("import", imported);
          confirmed.set("activate", activated);
          confirmed.set("album", album);
        });
        tail = result.catch(() => undefined);
        return result;
      };
    },
    get importAndActivateTrip() {
      const operation = native.importAndActivateTrip;
      if (operation === undefined) return undefined;
      return (
        command: Parameters<
          NonNullable<ActiveTripNativePort["importAndActivateTrip"]>
        >[0],
      ) => {
        const imported = JSON.stringify(command.envelope);
        const activated = JSON.stringify(command.activation);
        const result = tail.then(async () => {
          if (
            confirmed.get("import") === imported &&
            confirmed.get("activate") === activated
          )
            return;
          confirmed.delete("album");
          confirmed.delete("import");
          confirmed.delete("activate");
          await operation.call(native, command);
          confirmed.set("import", imported);
          confirmed.set("activate", activated);
        });
        tail = result.catch(() => undefined);
        return result;
      };
    },
    importTripKey: (
      command: Parameters<ActiveTripNativePort["importTripKey"]>[0],
    ) => run("import", command, () => native.importTripKey(command)),
    activateTrip: (
      command: Parameters<ActiveTripNativePort["activateTrip"]>[0],
    ) => run("activate", command, () => native.activateTrip(command)),
  });
}
