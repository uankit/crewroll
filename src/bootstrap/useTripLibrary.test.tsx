import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useTripLibrary } from "./useTripLibrary";
import type { TripListResponse } from "@crewroll/contracts";

const mockListTrips = jest.fn<Promise<TripListResponse>, []>();
let mockSessionPhase = "READY_NO_TRIP";
let mockCanReadLibrary = true;
let mockQueryScope = { opaqueAccountScope: "account-scope", deviceId: "phone" };
jest.mock("./AppSessionProvider", () => ({
  useAppSession: () => ({
    actions: { listTrips: mockListTrips },
    queryScope: mockQueryScope,
    snapshot: { phase: mockSessionPhase },
    capabilities: {
      canUseAuthenticatedShell: true,
      canReadLibrary: mockCanReadLibrary,
      canMutateTrip: false,
      canSharePhotos: false,
    },
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

beforeEach(() => {
  mockListTrips.mockReset().mockResolvedValue({ items: [] });
  mockSessionPhase = "READY_NO_TRIP";
  mockCanReadLibrary = true;
  mockQueryScope = { opaqueAccountScope: "account-scope", deviceId: "phone" };
});

const pastTrip: TripListResponse["items"][number] = {
  id: "018f22c4-6e80-7000-8000-000000000001",
  name: "Kyoto",
  status: "COMPLETE",
  participation: "LEFT",
  role: "OWNER",
  startsAt: "2030-01-01T00:00:00.000Z",
  endsAt: "2030-01-02T00:00:00.000Z",
  leftAt: "2030-01-02T00:00:00.000Z",
  sharingPaused: false,
  onThisDevice: true,
  memberCount: 2,
  savedPhotoCount: 8,
};

async function withLibraryTest(
  run: (harness: {
    client: QueryClient;
    view: Awaited<ReturnType<typeof renderLibrary>>;
  }) => Promise<void>,
) {
  jest.useFakeTimers();
  const previous = AppState.currentState;
  AppState.currentState = "active";
  const listener = jest
    .spyOn(AppState, "addEventListener")
    .mockReturnValue({ remove: jest.fn() });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = await renderLibrary(client);
  try {
    await run({ client, view });
  } finally {
    await view.unmount();
    client.clear();
    listener.mockRestore();
    AppState.currentState = previous;
    jest.useRealTimers();
  }
}
async function renderLibrary(client: QueryClient) {
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
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
  return view;
}

it("does not poll an empty current-trip view and still allows manual refresh", async () => {
  await withLibraryTest(async ({ view }) => {
    expect(mockListTrips).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(120_000);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(1);
    await act(async () => {
      await view.result.current.refetch();
    });
    expect(mockListTrips).toHaveBeenCalledTimes(2);
  });
});

it("polls pending membership promptly, then stops when it leaves the current view", async () => {
  mockListTrips.mockResolvedValue({
    items: [
      { ...pastTrip, status: "ACTIVE", participation: "JOINING", leftAt: null },
    ],
  });
  await withLibraryTest(async () => {
    expect(mockListTrips).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(2);
    mockListTrips.mockResolvedValue({ items: [] });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(120_000);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(3);
  });
});

it("keeps polling unfinished delivery until the current membership leaves", async () => {
  mockListTrips.mockResolvedValue({
    items: [
      { ...pastTrip, status: "ENDING", participation: "LEAVING", leftAt: null },
    ],
  });
  await withLibraryTest(async () => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(2);
  });
});

it("does not start an idle poll for a legacy response containing only past memberships", async () => {
  mockListTrips.mockResolvedValue({ items: [pastTrip] });
  await withLibraryTest(async () => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(120_000);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(1);
  });
});

it("keeps live session polling while its trip-library response catches up", async () => {
  mockSessionPhase = "READY_ACTIVE";
  await withLibraryTest(async () => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(2);
  });
});

it("never displays a previous account's late trip response after a scope switch", async () => {
  let finishPrevious!: (value: TripListResponse) => void;
  mockListTrips.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPrevious = resolve;
      }),
  );
  mockListTrips.mockResolvedValueOnce({ items: [] });
  await withLibraryTest(async ({ view }) => {
    expect(view.result.current.data).toBeUndefined();
    mockQueryScope = {
      opaqueAccountScope: "another-account",
      deviceId: "another-phone",
    };
    await view.rerender({ visible: true });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockListTrips).toHaveBeenCalledTimes(2);
    expect(view.result.current.data).toEqual({ items: [] });
    await act(async () => {
      finishPrevious({ items: [pastTrip] });
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(view.result.current.data).toEqual({ items: [] });
  });
});

test("allows safe metadata reads during domain provisioning only through explicit capability", async () => {
  mockSessionPhase = "PROVISIONING_DEVICE";
  await withLibraryTest(async () => {
    await act(() => jest.advanceTimersByTimeAsync(1));
    expect(mockListTrips).toHaveBeenCalledTimes(1);
  });
});

test("does not infer read authority from a READY domain phase", async () => {
  mockSessionPhase = "READY_ACTIVE";
  mockCanReadLibrary = false;
  await withLibraryTest(async () => {
    await act(() => jest.advanceTimersByTimeAsync(1));
    expect(mockListTrips).not.toHaveBeenCalled();
  });
});
