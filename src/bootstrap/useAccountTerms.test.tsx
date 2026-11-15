import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { AccountPolicy } from "@crewroll/contracts";
import { useAccountTerms } from "./useAccountTerms";

const policy = (accepted = false): AccountPolicy => ({
  accepted,
  termsVersion: "2026-09-24",
});

function fixture() {
  return {
    getAccountPolicy: jest.fn(async () => policy()),
    acceptAccountTerms: jest.fn(async () => policy(true)),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => jest.useRealTimers());

it("reads consent before showing acceptance and saves an explicit choice", async () => {
  const api = fixture();
  const { result } = await renderHook(() => useAccountTerms(api, "a", true));
  await waitFor(() => expect(result.current.checking).toBe(false));
  expect(result.current.ready).toBe(false);
  expect(result.current.requiresInput).toBe(true);
  expect(api.acceptAccountTerms).not.toHaveBeenCalled();
  await act(() => result.current.accept());
  expect(result.current.ready).toBe(true);
  expect(result.current.requiresInput).toBe(false);
});

it("turns a stalled policy read into a retryable error and ignores its late response", async () => {
  jest.useFakeTimers();
  const api = fixture();
  const stalled = deferred<AccountPolicy>();
  api.getAccountPolicy.mockReturnValueOnce(stalled.promise);
  const { result } = await renderHook(() => useAccountTerms(api, "a", true));
  await act(() => jest.advanceTimersByTimeAsync(15_000));
  expect(result.current.checking).toBe(false);
  expect(result.current.error).toContain("Couldn’t load");
  expect(result.current.requiresInput).toBe(false);
  await act(() => result.current.retry());
  expect(result.current.error).toBeNull();
  expect(result.current.ready).toBe(false);
  await act(() => stalled.resolve(policy(true)));
  expect(result.current.ready).toBe(false);
});

it("allows retry after a stalled acceptance without treating it as saved", async () => {
  jest.useFakeTimers();
  const api = fixture();
  api.acceptAccountTerms.mockReturnValueOnce(new Promise(() => {}));
  const { result } = await renderHook(() => useAccountTerms(api, "a", true));
  await act(() => jest.advanceTimersByTimeAsync(0));
  let acceptance!: Promise<void>;
  await act(() => {
    acceptance = result.current.accept();
  });
  await act(() => jest.advanceTimersByTimeAsync(15_000));
  await acceptance;
  expect(result.current.busy).toBe(false);
  expect(result.current.ready).toBe(false);
  expect(result.current.error).toContain("Couldn’t save");
  expect(result.current.requiresInput).toBe(true);
  await act(() => result.current.accept());
  expect(result.current.ready).toBe(true);
});

it("checks an existing account policy while its profile restores without repeating a known policy", async () => {
  const api = fixture();
  api.getAccountPolicy.mockResolvedValue(policy(true));
  const { result, rerender } = await renderHook(
    (profileReady: boolean) => useAccountTerms(api, "a", profileReady),
    { initialProps: false },
  );
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(api.getAccountPolicy).toHaveBeenCalledTimes(1);
  await rerender(true);
  expect(result.current.ready).toBe(true);
  expect(api.getAccountPolicy).toHaveBeenCalledTimes(1);
});

it("retries an unknown first-time policy after the canonical profile finishes", async () => {
  const api = fixture();
  api.getAccountPolicy.mockRejectedValueOnce(
    new Error("profile not stored yet"),
  );
  const { result, rerender } = await renderHook(
    (profileReady: boolean) => useAccountTerms(api, "a", profileReady),
    { initialProps: false },
  );
  await waitFor(() => expect(result.current.checking).toBe(false));
  expect(result.current.requiresInput).toBe(false);
  expect(result.current.error).toBeNull();
  await rerender(true);
  await waitFor(() => expect(result.current.requiresInput).toBe(true));
  expect(api.getAccountPolicy).toHaveBeenCalledTimes(2);
});

it("does not discard explicit acceptance when an independent profile completes", async () => {
  const api = fixture();
  const accepted = deferred<AccountPolicy>();
  api.acceptAccountTerms.mockReturnValueOnce(accepted.promise);
  const { result, rerender } = await renderHook(
    (profileReady: boolean) => useAccountTerms(api, "a", profileReady),
    { initialProps: false },
  );
  await waitFor(() => expect(result.current.requiresInput).toBe(true));
  let operation!: Promise<void>;
  await act(() => {
    operation = result.current.accept();
  });
  await rerender(true);
  expect(result.current.busy).toBe(true);
  await act(async () => {
    accepted.resolve(policy(true));
    await operation;
  });
  expect(result.current.ready).toBe(true);
  expect(result.current.busy).toBe(false);
  expect(api.getAccountPolicy).toHaveBeenCalledTimes(1);
});

it("does not let an old account's acceptance block or complete the new account", async () => {
  const api = fixture();
  const old = deferred<AccountPolicy>();
  api.acceptAccountTerms.mockReturnValueOnce(old.promise);
  const { result, rerender } = await renderHook(
    (accountId: string) => useAccountTerms(api, accountId, true),
    { initialProps: "a" },
  );
  await waitFor(() => expect(result.current.checking).toBe(false));
  let acceptance!: Promise<void>;
  await act(() => {
    acceptance = result.current.accept();
  });
  await rerender("b");
  await waitFor(() => expect(result.current.accountId).toBe("b"));
  await act(() => result.current.accept());
  expect(result.current.ready).toBe(true);
  await act(async () => {
    old.resolve(policy(false));
    await acceptance;
  });
  expect(result.current.accountId).toBe("b");
  expect(result.current.ready).toBe(true);
});
