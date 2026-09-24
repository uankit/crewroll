import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useTripLibrary } from "./useTripLibrary";

const mockListTrips = jest.fn(async () => ({ items: [] }));
jest.mock("./AppSessionProvider", () => ({
  useAppSession: () => ({
    actions: { listTrips: mockListTrips },
    queryScope: { opaqueAccountScope: "account-scope", deviceId: "phone" },
  }),
}));

test("polls only while Home is visible and the app is active, then refreshes on return", async () => {
  jest.useFakeTimers();
  const initialState = AppState.currentState;
  AppState.currentState = "active";
  let onChange: (state: AppStateStatus) => void = () => {};
  const remove = jest.fn();
  const listener = jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_event, handler) => {
      onChange = handler;
      return { remove };
    });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  try {
    const view = await renderHook(
      ({ visible }: { visible: boolean }) => useTripLibrary(visible),
      {
        initialProps: { visible: true },
        wrapper: Wrapper,
      },
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(1);
    await view.rerender({ visible: false });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(1);
    await view.rerender({ visible: true });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(2);
    await act(async () => {
      onChange("background");
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(2);
    await act(async () => {
      onChange("active");
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(3);
    await view.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    client.clear();
    listener.mockRestore();
    AppState.currentState = initialState;
    jest.useRealTimers();
  }
});
