import type { TripSessionActions } from "./AppSessionProvider";
import {
  createPhotoReadinessReconciler,
  permissionForLobbyEntry,
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
});
