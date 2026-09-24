import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import type {
  PhotoLibraryPermissionPort,
  PhotoLibraryPermissionState,
} from "../infrastructure/media/expoPhotoLibraryPermission";
import { usePhotoAccessSetup } from "./usePhotoAccessSetup";

jest.mock("../infrastructure/media/photoAccessSetupCache", () => ({
  photoAccessSetupCache: {},
}));

const requestable: PhotoLibraryPermissionState = {
  kind: "REQUESTABLE",
  fullPhotoLibraryAccess: false,
  canAskAgain: true,
};
const full: PhotoLibraryPermissionState = {
  kind: "FULL",
  fullPhotoLibraryAccess: true,
  canAskAgain: true,
};
const blocked: PhotoLibraryPermissionState = {
  kind: "SETTINGS_REQUIRED",
  fullPhotoLibraryAccess: false,
  canAskAgain: false,
};

function fixture(initial = requestable) {
  const permission: jest.Mocked<PhotoLibraryPermissionPort> = {
    read: jest.fn(async () => initial),
    request: jest.fn(async () => full),
    openSettings: jest.fn(async () => {}),
  };
  const remembered = new Set<string>();
  const cache = {
    read: jest.fn(async (scope: string, id: string) =>
      remembered.has(`${scope}:${id}`),
    ),
    write: jest.fn(async (scope: string, id: string) => {
      remembered.add(`${scope}:${id}`);
    }),
  };
  return {
    permission,
    cache,
    scope: "https://api.example.test",
    accountId: "new-user" as string | null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("photo access during account setup", () => {
  afterEach(() => jest.restoreAllMocks());

  it("offers the native prompt before a user chooses either host or guest, with no trip dependency", async () => {
    const f = fixture();
    const { result } = await renderHook(() => usePhotoAccessSetup(f));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.complete).toBe(false);
    expect(f.permission.request).not.toHaveBeenCalled();
    expect(f.permission.openSettings).not.toHaveBeenCalled();
    await act(() => result.current.request());
    expect(f.permission.request).toHaveBeenCalledTimes(1);
    expect(f.permission.openSettings).not.toHaveBeenCalled();
    expect(result.current.complete).toBe(true);
    expect(f.cache.write).toHaveBeenCalledWith(f.scope, f.accountId);
  });

  it("reuses an existing grant without prompting again", async () => {
    const f = fixture(full);
    const { result } = await renderHook(() => usePhotoAccessSetup(f));
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(f.permission.request).not.toHaveBeenCalled();
    expect(f.permission.openSettings).not.toHaveBeenCalled();
  });

  it("remembers an explicit skip only for that account and backend", async () => {
    const f = fixture();
    const first = await renderHook(() => usePhotoAccessSetup(f));
    await waitFor(() => expect(first.result.current.checking).toBe(false));
    await act(() => first.result.current.defer());
    expect(first.result.current.complete).toBe(true);
    await first.unmount();
    const returning = await renderHook(
      (props: ReturnType<typeof fixture>) => usePhotoAccessSetup(props),
      {
        initialProps: f,
      },
    );
    await waitFor(() => expect(returning.result.current.complete).toBe(true));
    await returning.rerender({ ...f, accountId: "another-user" });
    await waitFor(() => expect(returning.result.current.checking).toBe(false));
    expect(returning.result.current.complete).toBe(false);
    await returning.rerender({ ...f, scope: "https://other.example.test" });
    await waitFor(() => expect(returning.result.current.checking).toBe(false));
    expect(returning.result.current.complete).toBe(false);
    expect(f.permission.request).not.toHaveBeenCalled();
  });

  it("never sends a denial to Settings automatically and coalesces repeated taps", async () => {
    const f = fixture();
    const pending = deferred<PhotoLibraryPermissionState>();
    f.permission.request.mockReturnValueOnce(pending.promise);
    const { result } = await renderHook(() => usePhotoAccessSetup(f));
    await waitFor(() => expect(result.current.checking).toBe(false));
    let request!: Promise<void>;
    await act(() => {
      request = result.current.request();
    });
    expect(result.current.busy).toBe(true);
    await act(() => result.current.request());
    await act(() => result.current.defer());
    expect(result.current.complete).toBe(false);
    await act(async () => {
      pending.resolve(blocked);
      await request;
    });
    expect(result.current.settingsRequired).toBe(true);
    expect(f.permission.request).toHaveBeenCalledTimes(1);
    expect(f.permission.openSettings).not.toHaveBeenCalled();
    await act(() => result.current.request());
    expect(f.permission.openSettings).toHaveBeenCalledTimes(1);
  });

  it("continues automatically after granting access in Settings", async () => {
    let foreground!: (state: AppStateStatus) => void;
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_event, listener) => {
        foreground = listener;
        return { remove: jest.fn() };
      });
    const f = fixture(blocked);
    const { result } = await renderHook(() => usePhotoAccessSetup(f));
    await waitFor(() => expect(result.current.settingsRequired).toBe(true));
    await act(() => result.current.request());
    await act(() => foreground("background"));
    f.permission.read.mockResolvedValue(full);
    await act(() => foreground("active"));
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(f.permission.request).not.toHaveBeenCalled();
  });

  it("does not treat a failed local read as a Settings requirement", async () => {
    const f = fixture();
    f.permission.read.mockRejectedValueOnce(new Error("native unavailable"));
    const { result } = await renderHook(() => usePhotoAccessSetup(f));
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.settingsRequired).toBe(false);
    await act(() => result.current.request());
    expect(result.current.complete).toBe(true);
    expect(f.permission.openSettings).not.toHaveBeenCalled();
  });

  it("ignores an old account's prompt result after signing into a different account", async () => {
    const f = fixture();
    const pending = deferred<PhotoLibraryPermissionState>();
    f.permission.request.mockReturnValueOnce(pending.promise);
    const { result, rerender } = await renderHook(
      (props: ReturnType<typeof fixture>) => usePhotoAccessSetup(props),
      { initialProps: f },
    );
    await waitFor(() => expect(result.current.checking).toBe(false));
    let request!: Promise<void>;
    await act(() => {
      request = result.current.request();
    });
    await rerender({ ...f, accountId: "another-user" });
    await waitFor(() => expect(result.current.checking).toBe(false));
    await act(async () => {
      pending.resolve(full);
      await request;
    });
    expect(result.current.complete).toBe(false);
    expect(f.cache.write).not.toHaveBeenCalled();
  });
});
