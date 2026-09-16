import { useUser } from "@clerk/expo";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { profileName } from "../../domain/auth/profileName";
import { useProfileCompletion } from "./useProfileCompletion";

jest.mock("@clerk/expo", () => ({ useUser: jest.fn() }));
jest.mock("./profileSyncCache", () => ({ profileSyncCache: {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(name: string | null = null) {
  const user = {
    id: "account-a",
    fullName: name,
    firstName: name,
    username: null,
    update: jest.fn(async (input: { firstName: string; lastName: null }) => {
      user.fullName = input.firstName;
      user.firstName = input.firstName;
    }),
  };
  (useUser as jest.Mock).mockImplementation(() => ({ isLoaded: true, user }));
  const saved = new Map<string, string>();
  const cache = {
    read: jest.fn(
      async (scope: string, id: string) => saved.get(`${scope}:${id}`) ?? null,
    ),
    write: jest.fn(async (scope: string, id: string, value: string) => {
      saved.set(`${scope}:${id}`, value);
    }),
  };
  const api = {
    syncProfile: jest.fn(async () => ({
      displayName: user.fullName ?? "CrewRoll member",
    })),
  };
  return {
    user,
    cache,
    api,
    options: { api, cache, scope: "https://api.example.test" },
  };
}

describe("profile completion", () => {
  it("normalizes a display name without requiring a surname and rejects empty or hidden controls", () => {
    expect(profileName("  Jose\u0301   李  ")).toBe("José 李");
    expect(profileName("Riya")).toBe("Riya");
    expect(profileName(" ")).toBeNull();
    expect(profileName("Riya\u202e")).toBeNull();
    expect(profileName("a".repeat(81))).toBeNull();
  });

  it("saves a missing name once, coalesces taps and skips sync on a later launch", async () => {
    const f = fixture();
    const { result, unmount } = await renderHook(() =>
      useProfileCompletion(f.options),
    );
    expect(result.current.ready).toBe(false);
    expect(f.api.syncProfile).not.toHaveBeenCalled();
    await act(() => result.current.setName(" Riya  Shah "));
    await act(async () => {
      await Promise.all([result.current.save(), result.current.save()]);
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(f.user.update).toHaveBeenCalledTimes(1);
    expect(f.user.update).toHaveBeenCalledWith({
      firstName: "Riya Shah",
      lastName: null,
    });
    expect(f.api.syncProfile).toHaveBeenCalledTimes(1);
    await unmount();
    const returning = await renderHook(() => useProfileCompletion(f.options));
    await waitFor(() => expect(returning.result.current.ready).toBe(true));
    expect(f.api.syncProfile).toHaveBeenCalledTimes(1);
  });

  it("retries a failed server sync without updating the identity provider again", async () => {
    const f = fixture();
    f.api.syncProfile.mockRejectedValueOnce(new Error("offline"));
    const { result } = await renderHook(() => useProfileCompletion(f.options));
    await act(() => result.current.setName("Ananya"));
    await act(() => result.current.save());
    expect(result.current.ready).toBe(false);
    expect(result.current.error).toMatch(/try again/);
    expect(f.cache.write).not.toHaveBeenCalled();
    await act(() => result.current.save());
    expect(result.current.ready).toBe(true);
    expect(f.user.update).toHaveBeenCalledTimes(1);
    expect(f.api.syncProfile).toHaveBeenCalledTimes(2);
  });

  it("does not publish a stale profile when the account changes during sync", async () => {
    const f = fixture("Riya");
    const pending = deferred<{ displayName: string }>();
    f.api.syncProfile.mockReturnValueOnce(pending.promise);
    const { result, rerender } = await renderHook(() =>
      useProfileCompletion(f.options),
    );
    await waitFor(() => expect(f.api.syncProfile).toHaveBeenCalledTimes(1));
    f.user.id = "account-b";
    f.user.fullName = null;
    f.user.firstName = null;
    await rerender({});
    await act(() => pending.resolve({ displayName: "Riya" }));
    expect(result.current.ready).toBe(false);
    expect(result.current.name).toBe("");
    expect(f.cache.write).not.toHaveBeenCalled();
  });

  it("keeps the name form visible when editing after an automatic sync fails", async () => {
    const f = fixture("Riya");
    f.api.syncProfile.mockRejectedValueOnce(new Error("offline"));
    const { result } = await renderHook(() => useProfileCompletion(f.options));
    await waitFor(() => expect(result.current.error).toMatch(/try again/));
    await act(() => result.current.setName("Riya Shah"));
    expect(result.current.checking).toBe(false);
    expect(result.current.ready).toBe(false);
    await act(() => result.current.save());
    expect(result.current.ready).toBe(true);
    expect(result.current.name).toBe("Riya Shah");
  });

  it("restarts a superseded name sync and never marks the older name as current", async () => {
    const f = fixture("Riya");
    const pending = deferred<{ displayName: string }>();
    f.api.syncProfile.mockReturnValueOnce(pending.promise);
    const { result, rerender } = await renderHook(() =>
      useProfileCompletion(f.options),
    );
    await waitFor(() => expect(f.api.syncProfile).toHaveBeenCalledTimes(1));
    f.user.fullName = "Riya Shah";
    await rerender({});
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => pending.resolve({ displayName: "Riya" }));
    expect(result.current.name).toBe("Riya Shah");
    expect(f.cache.write).toHaveBeenCalledTimes(1);
    expect(f.cache.write).toHaveBeenCalledWith(
      f.options.scope,
      "account-a",
      "Riya Shah",
    );
  });

  it("never opens the gate before Clerk finishes loading", async () => {
    const f = fixture();
    (useUser as jest.Mock).mockReturnValue({ isLoaded: false, user: null });
    const { result } = await renderHook(() => useProfileCompletion(f.options));
    expect(result.current.ready).toBe(false);
    expect(result.current.checking).toBe(true);
  });
});
