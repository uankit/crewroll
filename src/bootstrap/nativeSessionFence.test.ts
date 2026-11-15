import { createNativeSessionFence } from "./nativeSessionFence";
import type { CrewRollTransferPort } from "../infrastructure/native/crewRollTransfer";

function fixture() {
  const native = Object.fromEntries(
    [
      "ensureDeviceIdentity",
      "installDeviceSession",
      "refreshDeviceSession",
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

  it("rejects a refresh completion after signout and never dispatches an old refresh into the replacement session", async () => {
    const { native, fence } = fixture();
    let complete!: () => void;
    native.refreshDeviceSession = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const old = fence.capture();
    const command = {} as Parameters<
      NonNullable<CrewRollTransferPort["refreshDeviceSession"]>
    >[0];
    const pending = old.refreshDeviceSession!(command);
    const rejected = expect(pending).rejects.toThrow("Native session ended");
    fence.invalidate();
    complete();
    await rejected;
    await expect(old.refreshDeviceSession!(command)).rejects.toThrow(
      "Native session ended",
    );
    expect(native.refreshDeviceSession).toHaveBeenCalledTimes(1);
  });
});

it.each(["prepareDeviceSession", "importAndActivateTrip"] as const)(
  "rejects late and queued %s completions across an account change",
  async (name) => {
    const { native, fence } = fixture();
    let complete!: (value: never) => void;
    const completion = new Promise<never>((resolve) => {
      complete = resolve;
    });
    const operation = jest.fn(() => completion);
    native[name] = operation;
    const old = fence.capture();
    const command = {
      protocolVersion: 1,
      envelope: {},
      activation: {},
    } as never;
    const dispatch = old[name]!;
    const pending = dispatch(command);
    const rejected = expect(pending).rejects.toThrow("Native session ended");
    await Promise.resolve();
    const queued = dispatch(command);
    const rejectedQueued = expect(queued).rejects.toThrow(
      "Native session ended",
    );
    fence.invalidate();
    complete(undefined as never);
    await rejected;
    await rejectedQueued;
    expect(operation).toHaveBeenCalledTimes(
      name === "prepareDeviceSession" ? 2 : 1,
    );
    await expect(dispatch(command)).rejects.toThrow("Native session ended");
    expect(() => old[name]).toThrow("Native session ended");
  },
);

it("keeps optional capability discovery lazy when creating/capturing the account fence", () => {
  const { native } = fixture();
  const discover = jest.fn(() => undefined);
  Object.defineProperty(native, "prepareDeviceSession", { get: discover });
  Object.defineProperty(native, "importAndActivateTrip", { get: discover });
  const fence = createNativeSessionFence(native);
  const captured = fence.capture();
  expect(discover).not.toHaveBeenCalled();
  expect(captured.prepareDeviceSession).toBeUndefined();
  expect(captured.importAndActivateTrip).toBeUndefined();
});

it("fences metadata-only selection before dispatch and after late account-change completion", async () => {
  const { native, fence } = fixture();
  let finish!: (value: { protocolVersion: 1; activeTripId: null }) => void;
  const operation = jest.fn(
    () =>
      new Promise<{ protocolVersion: 1; activeTripId: null }>((resolve) => {
        finish = resolve;
      }),
  );
  native.getActiveTripSelection = operation;
  const old = fence.capture();
  const selection = old.getActiveTripSelection!;
  const command = {
    protocolVersion: 1,
    accountId: "user_one",
    installationId: "install_one",
  } as const;
  const pending = selection(command);
  const rejected = expect(pending).rejects.toThrow("Native session ended");
  fence.invalidate();
  finish({ protocolVersion: 1, activeTripId: null });
  await rejected;
  await expect(selection(command)).rejects.toThrow("Native session ended");
  expect(operation).toHaveBeenCalledTimes(1);
  expect(() => old.getActiveTripSelection).toThrow("Native session ended");
  expect(native.getSnapshot).not.toHaveBeenCalled();
});
