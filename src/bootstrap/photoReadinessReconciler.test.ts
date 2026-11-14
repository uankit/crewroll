import type { TripSessionActions } from "./AppSessionProvider";
import { act, renderHook } from "@testing-library/react-native";
import { useLayoutEffect, useState } from "react";
import { AppState } from "react-native";
import {
  canPublishPhotoReadiness,
  createPhotoReadinessReconciler,
  permissionForLobbyEntry,
  usePhotoReadinessRecovery,
} from "./photoReadinessReconciler";
import type { TripView } from "../domain/trips/model";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("photo readiness reconciliation sequencing", () => {
  it.each(["OWNER", "MEMBER"] as const)(
    "waits for the current %s membership and nominated phone to become available",
    (role) => {
      const trip: TripView = {
        id: "018f22c4-6e80-7000-8000-000000000001",
        version: 1,
        name: "Kyoto",
        status: "LOBBY",
        release: { mode: "IMMEDIATE" },
        startsAt: null,
        endsAt: "2030-01-02T00:00:00.000Z",
        ownerDeviceId: "10000000-0000-4000-8000-000000000001",
        currentMembershipId: "20000000-0000-4000-8000-000000000001",
        members: [
          {
            membershipId: "20000000-0000-4000-8000-000000000001",
            role,
            displayName: "Test member",
            status: "PENDING_KEY",
            fullPhotoLibraryAccess: false,
            deviceState: "AVAILABLE",
            isCurrentMember: true,
          },
        ],
      };
      expect(canPublishPhotoReadiness(null)).toBe(false);
      expect(canPublishPhotoReadiness(trip)).toBe(false);
      const approved: TripView = {
        ...trip,
        members: trip.members.map((member) => ({
          ...member,
          status: "ACTIVE",
        })),
      };
      expect(canPublishPhotoReadiness(approved)).toBe(true);
      for (const deviceState of ["NOT_DISCLOSED", "MISSING"] as const) {
        expect(
          canPublishPhotoReadiness({
            ...approved,
            members: approved.members.map((member) => ({
              ...member,
              deviceState,
            })),
          }),
        ).toBe(false);
      }
      expect(
        canPublishPhotoReadiness({
          ...approved,
          currentMembershipId: "20000000-0000-4000-8000-000000000002",
        }),
      ).toBe(false);
    },
  );
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
  it("blocks the first AVAILABLE render after a device becomes MISSING and AVAILABLE before passive effects settle", async () => {
    const nextPermissionRead = deferred();
    const actions = {
      invalidatePhotoReadiness: jest.fn(),
      publishPhotoReadiness: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async () => nextPermissionRead.promise),
    } as unknown as TripSessionActions;
    const observed: { available: boolean; checked: boolean }[] = [];
    const hook = await renderHook(() => {
      const [available, setAvailable] = useState(true);
      const readiness = usePhotoReadinessRecovery(
        actions,
        "A",
        true,
        available,
      );
      useLayoutEffect(() => {
        observed.push({ available, checked: readiness.checked });
        if (!available) setAvailable(true);
      }, [available, readiness.checked]);
      return { ...readiness, loseDevice: () => setAvailable(false) };
    });
    await act(async () => {});
    expect(hook.result.current.checked).toBe(true);
    observed.length = 0;
    await act(async () => hook.result.current.loseDevice());
    expect(observed.find((entry) => entry.available)?.checked).toBe(false);
    expect(hook.result.current.checked).toBe(false);
    await act(async () => nextPermissionRead.resolve());
    expect(hook.result.current.checked).toBe(true);
    await hook.unmount();
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

  it("rechecks after a settings return that overlaps an older passive permission read", async () => {
    let onState!: (state: "active" | "background") => void;
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_event, listener) => {
        onState = listener;
        return { remove: jest.fn() };
      });
    const beforeSettings = deferred();
    const actions = {
      invalidatePhotoReadiness: jest.fn(),
      publishPhotoReadiness: jest
        .fn()
        .mockImplementationOnce(async () => beforeSettings.promise)
        .mockResolvedValue(undefined),
    } as unknown as TripSessionActions;
    const hook = await renderHook(() =>
      usePhotoReadinessRecovery(actions, "A", true, true),
    );
    await act(async () => {});
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(1);
    await act(async () => {
      onState("background");
      onState("active");
      onState("active");
    });
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(1);
    await act(async () => beforeSettings.resolve());
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(2);
    expect(actions.publishPhotoReadiness).toHaveBeenNthCalledWith(
      2,
      "A",
      false,
    );
    expect(hook.result.current.checked).toBe(true);
    await hook.unmount();
  });

  it("clears checked immediately on foreground return until the current permission read finishes", async () => {
    let onState!: (state: "active" | "background") => void;
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_event, listener) => {
        onState = listener;
        return { remove: jest.fn() };
      });
    const currentPermission = deferred();
    const actions = {
      invalidatePhotoReadiness: jest.fn(),
      publishPhotoReadiness: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async () => currentPermission.promise),
    } as unknown as TripSessionActions;
    const hook = await renderHook(() =>
      usePhotoReadinessRecovery(actions, "A", true, true),
    );
    await act(async () => {});
    expect(hook.result.current.checked).toBe(true);
    await act(async () => {
      onState("background");
      onState("active");
    });
    expect(hook.result.current.checked).toBe(false);
    expect(
      permissionForLobbyEntry(true, hook.result.current.checked, {
        kind: "FULL",
        fullPhotoLibraryAccess: true,
        canAskAgain: false,
      }),
    ).toEqual({ kind: "CHECKING" });
    await act(async () => currentPermission.resolve());
    expect(hook.result.current.checked).toBe(true);
    await hook.unmount();
  });

  it("rechecks after foreground return during an explicit permission sync without requesting again", async () => {
    let onState!: (state: "active" | "background") => void;
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_event, listener) => {
        onState = listener;
        return { remove: jest.fn() };
      });
    const prompt = deferred();
    const actions = {
      invalidatePhotoReadiness: jest.fn(),
      publishPhotoReadiness: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async () => prompt.promise),
    } as unknown as TripSessionActions;
    const hook = await renderHook(() =>
      usePhotoReadinessRecovery(actions, "A", true, true),
    );
    await act(async () => {});
    await act(async () => hook.result.current.request());
    await act(async () => {
      onState("background");
      onState("active");
      onState("active");
      prompt.resolve();
    });
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(3);
    expect(actions.publishPhotoReadiness).toHaveBeenNthCalledWith(2, "A", true);
    expect(actions.publishPhotoReadiness).toHaveBeenLastCalledWith("A", false);
    expect(hook.result.current.checked).toBe(true);
    await hook.unmount();
  });

  it("discards a queued settings follow-up after the visible trip unmounts", async () => {
    let onState!: (state: "active" | "background") => void;
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_event, listener) => {
        onState = listener;
        return { remove: jest.fn() };
      });
    const first = deferred();
    const actions = {
      invalidatePhotoReadiness: jest.fn(),
      publishPhotoReadiness: jest.fn(async () => first.promise),
    } as unknown as TripSessionActions;
    const hook = await renderHook(() =>
      usePhotoReadinessRecovery(actions, "A", true, true),
    );
    await act(async () => {});
    await act(async () => {
      onState("background");
      onState("active");
    });
    await hook.unmount();
    await act(async () => first.resolve());
    expect(actions.publishPhotoReadiness).toHaveBeenCalledTimes(1);
  });
});
