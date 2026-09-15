import { createNativeSessionFence } from "./nativeSessionFence";
import type { CrewRollTransferPort } from "../infrastructure/native/crewRollTransfer";

function fixture() {
  const native = Object.fromEntries(
    [
      "ensureDeviceIdentity",
      "installDeviceSession",
      "clearDeviceSession",
      "createTripKey",
      "discardProvisionalTripKey",
      "wrapTripKey",
      "importTripKey",
      "activateTrip",
      "deactivateTrip",
      "setTransferPolicy",
      "reconcileNow",
      "retry",
      "getSnapshot",
      "listAssets",
      "subscribeToInvalidations",
    ].map((method) => [method, jest.fn().mockResolvedValue(undefined)]),
  ) as unknown as jest.Mocked<CrewRollTransferPort>;
  return { native, fence: createNativeSessionFence(native) };
}

describe("native session fence", () => {
  it("rejects a late key import completion and prevents activation after sign-out", async () => {
    const { native, fence } = fixture();
    let complete!: () => void;
    native.importTripKey.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const captured = fence.capture();
    const workflow = async () => {
      await captured.importTripKey(
        {} as Parameters<CrewRollTransferPort["importTripKey"]>[0],
      );
      await captured.activateTrip(
        {} as Parameters<CrewRollTransferPort["activateTrip"]>[0],
      );
    };
    const work = workflow();
    const rejected = expect(work).rejects.toThrow("Native session ended");
    await Promise.resolve(); // The serialized native preparation queue dispatches asynchronously.
    fence.invalidate();
    complete();
    await rejected;
    expect(native.activateTrip).not.toHaveBeenCalled();
  });

  it("prevents stale device-session installation even if an old API request completes", async () => {
    const { native, fence } = fixture();
    const old = fence.capture();
    fence.invalidate();
    await expect(
      old.installDeviceSession(
        {} as Parameters<CrewRollTransferPort["installDeviceSession"]>[0],
      ),
    ).rejects.toThrow("Native session ended");
    expect(native.installDeviceSession).not.toHaveBeenCalled();
    await fence
      .capture()
      .installDeviceSession(
        {} as Parameters<CrewRollTransferPort["installDeviceSession"]>[0],
      );
    expect(native.installDeviceSession).toHaveBeenCalledTimes(1);
  });

  it("guards every async method before native dispatch and never invalidates a new scope with an old completion", async () => {
    const { native, fence } = fixture();
    const old = fence.capture();
    fence.invalidate();
    const current = fence.capture();
    for (const name of Object.keys(native).filter(
      (name) => name !== "subscribeToInvalidations",
    )) {
      const operation = old[
        name as keyof CrewRollTransferPort
      ] as () => Promise<unknown>;
      await expect(operation()).rejects.toThrow("Native session ended");
      expect(native[name as keyof CrewRollTransferPort]).not.toHaveBeenCalled();
    }
    await current.getSnapshot();
    expect(native.getSnapshot).toHaveBeenCalledTimes(1);
  });
});
