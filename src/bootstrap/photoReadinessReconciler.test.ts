import type { TripSessionActions } from "./AppSessionProvider";
import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import {
  createPhotoReadinessReconciler,
  permissionForLobbyEntry,
  usePhotoReadinessRecovery,
} from "./photoReadinessReconciler";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("photo readiness reconciliation sequencing", () => {
  it("shows CHECKING on the first render of a same-trip re-entry", () => {
    const full = {
      kind: "FULL" as const,
      fullPhotoLibraryAccess: true as const,
      canAskAgain: false,
    };
    expect(permissionForLobbyEntry(false, false, full)).toEqual({
      kind: "CHECKING",
    });
    expect(permissionForLobbyEntry(true, true, full)).toBe(full);
  });

  it("advances the entry before the first focused A-to-B parameter render", () => {
    expect(
      permissionForLobbyEntry(false, true, {
        kind: "FULL",
        fullPhotoLibraryAccess: true,
        canAskAgain: false,
      }),
    ).toEqual({ kind: "CHECKING" });
  });
  it("blocks B immediately and reruns it after unresolved A", async () => {
    const first = deferred();
    const actions = {
      invalidatePhotoReadiness: jest.fn(),
      publishPhotoReadiness: jest
        .fn()
        .mockImplementationOnce(async () => first.promise)
        .mockResolvedValue({ kind: "READY", tripId: "B" }),
    } as unknown as TripSessionActions;
    const reconciler = createPhotoReadinessReconciler();
    reconciler.reconcile(actions, "A");
    const drained = reconciler.reconcile(actions, "B");
    expect(actions.invalidatePhotoReadiness).toHaveBeenCalledTimes(2);
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(1);
    first.resolve();
    await drained;
    expect(actions.publishPhotoReadiness).toHaveBeenLastCalledWith("B", false);
  });

  it("coalesces a foreground event while the same trip is in flight", async () => {
    const first = deferred();
    const actions = {
      invalidatePhotoReadiness: jest.fn(),
      publishPhotoReadiness: jest
        .fn()
        .mockImplementationOnce(async () => first.promise)
        .mockResolvedValue({ kind: "READY", tripId: "A" }),
    } as unknown as TripSessionActions;
    const reconciler = createPhotoReadinessReconciler();
    reconciler.reconcile(actions, "A");
    const drained = reconciler.reconcile(actions, "A");
    first.resolve();
    await drained;
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(1);
    expect(actions.invalidatePhotoReadiness).toHaveBeenCalledTimes(1);
  });
  it("opens a permission prompt only for Continue and coalesces its foreground event", async () => {
    const first = deferred();
    const actions = {
      invalidatePhotoReadiness: jest.fn(),
      publishPhotoReadiness: jest.fn(async () => first.promise),
    } as unknown as TripSessionActions;
    const reconciler = createPhotoReadinessReconciler();
    reconciler.reconcile(actions, "A", true);
    const drained = reconciler.reconcile(actions, "A");
    first.resolve();
    await drained;
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(1);
    expect(actions.publishPhotoReadiness).toHaveBeenCalledWith("A", true);
  });

  it("does not lose a permission tap behind a passive check or a later foreground event", async () => {
    const first = deferred();
    const actions = {
      invalidatePhotoReadiness: jest.fn(),
      publishPhotoReadiness: jest
        .fn()
        .mockImplementationOnce(async () => first.promise)
        .mockResolvedValue(undefined),
    } as unknown as TripSessionActions;
    const reconciler = createPhotoReadinessReconciler();
    reconciler.reconcile(actions, "A");
    reconciler.reconcile(actions, "A", true);
    reconciler.reconcile(actions, "A", true);
    const drained = reconciler.reconcile(actions, "A");
    first.resolve();
    await drained;
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(2);
    expect(actions.publishPhotoReadiness).toHaveBeenNthCalledWith(
      1,
      "A",
      false,
    );
    expect(actions.publishPhotoReadiness).toHaveBeenNthCalledWith(2, "A", true);
  });
});

describe("visible trip readiness recovery", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it("retries an interrupted sync without opening another permission prompt", async () => {
    jest.useFakeTimers();
    const actions = {
      invalidatePhotoReadiness: jest.fn(),
      publishPhotoReadiness: jest
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ kind: "READY", tripId: "A" }),
    } as unknown as TripSessionActions;
    const hook = await renderHook(() =>
      usePhotoReadinessRecovery(actions, "A", true, true),
    );
    await act(async () => {});
    expect(hook.result.current.failed).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(2);
    expect(actions.publishPhotoReadiness).toHaveBeenLastCalledWith("A", false);
    expect(hook.result.current.failed).toBe(false);
    expect(hook.result.current.checked).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(2);
    await hook.unmount();
  });
  it("pauses retries in the background and rechecks on return", async () => {
    jest.useFakeTimers();
    let onState!: (state: "active" | "background") => void;
    const removed = jest.fn();
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_event, listener) => {
        onState = listener;
        return { remove: removed };
      });
    const actions = {
      invalidatePhotoReadiness: jest.fn(),
      publishPhotoReadiness: jest
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ kind: "READY", tripId: "A" }),
    } as unknown as TripSessionActions;
    const hook = await renderHook(() =>
      usePhotoReadinessRecovery(actions, "A", true, true),
    );
    await act(async () => {});
    await act(async () => {
      onState("background");
      jest.advanceTimersByTime(60_000);
    });
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(1);
    await act(async () => {
      onState("active");
    });
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(2);
    await hook.unmount();
    expect(removed).toHaveBeenCalled();
  });
});
