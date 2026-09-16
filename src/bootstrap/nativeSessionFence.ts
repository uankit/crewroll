import type { CrewRollTransferPort } from "../infrastructure/native/crewRollTransfer";
import type { RestoreDeviceSessionCommand } from "@crewroll/contracts/native/protocol";
import { createPreparedTripNative } from "../application/trips/preparedTripNative";

/** Invalidates old workflow continuations before they can dispatch native writes. */
export function createNativeSessionFence(native: CrewRollTransferPort) {
  let generation = 0;
  return Object.freeze({
    invalidate() {
      generation += 1;
    },
    get generation() {
      return generation;
    },
    capture(): CrewRollTransferPort {
      const captured = generation;
      const check = () => {
        if (captured !== generation) throw new Error("Native session ended");
      };
      const guard =
        <Args extends unknown[], Result>(
          operation: (...args: Args) => Promise<Result>,
        ) =>
        async (...args: Args): Promise<Result> => {
          check();
          const result = await operation(...args);
          check();
          return result;
        };
      // Both queued dispatch and cached success must remain behind the account fence.
      const prepared = createPreparedTripNative({
        importTripKey: guard(native.importTripKey.bind(native)),
        activateTrip: guard(native.activateTrip.bind(native)),
      });
      return Object.freeze({
        restoreDeviceSession: guard(
          async (command: RestoreDeviceSessionCommand) =>
            native.restoreDeviceSession?.(command) ?? null,
        ),
        ensureDeviceIdentity: guard(native.ensureDeviceIdentity.bind(native)),
        installDeviceSession: guard(native.installDeviceSession.bind(native)),
        clearDeviceSession: guard(native.clearDeviceSession.bind(native)),
        createTripKey: guard(native.createTripKey.bind(native)),
        discardProvisionalTripKey: guard(
          native.discardProvisionalTripKey.bind(native),
        ),
        wrapTripKey: guard(native.wrapTripKey.bind(native)),
        importTripKey: guard(prepared.importTripKey),
        activateTrip: guard(prepared.activateTrip),
        deactivateTrip: guard(native.deactivateTrip.bind(native)),
        setTransferPolicy: guard(native.setTransferPolicy.bind(native)),
        reconcileNow: guard(native.reconcileNow.bind(native)),
        retry: guard(native.retry.bind(native)),
        getSnapshot: guard(native.getSnapshot.bind(native)),
        listAssets: guard(native.listAssets.bind(native)),
        subscribeToInvalidations(
          listener: Parameters<
            CrewRollTransferPort["subscribeToInvalidations"]
          >[0],
        ) {
          check();
          return native.subscribeToInvalidations((event) => {
            if (captured === generation) listener(event);
          });
        },
      });
    },
  });
}
