import { act, render, screen } from "@testing-library/react-native";
import { AppState, Text } from "react-native";
import { PushWakeProvider, usePushWakeStatus } from "./PushWakeProvider";

let mockScope: { opaqueAccountScope: string; deviceId: string } | null = null;
let mockHint:
  | ((hint: {
      deviceId: string;
      tripId: string;
      eventId: string;
      type: string;
    }) => void)
  | undefined;
const mockRemove = jest.fn();
const mockInvalidate = jest.fn(
  async (_input: { queryKey: readonly string[]; exact: boolean }) => {},
);
const mockQueryClient = { invalidateQueries: mockInvalidate };
const mockAcquire = jest.fn(async () => {
  throw new Error("Firebase config absent");
});
jest.mock("./AppSessionProvider", () => ({
  useAppSession: () => ({ queryScope: mockScope }),
}));
jest.mock("@tanstack/react-query", () => ({
  ...jest.requireActual("@tanstack/react-query"),
  useQueryClient: () => mockQueryClient,
}));
jest.mock("expo-notifications/build/getDevicePushTokenAsync", () => ({
  getDevicePushTokenAsync: () => mockAcquire(),
}));
jest.mock("expo-notifications/build/TokenEmitter", () => ({
  addPushTokenListener: () => ({ remove: mockRemove }),
}));
jest.mock("../infrastructure/native/crewRollTransfer", () => ({
  crewRollTransfer: {
    subscribeToPushHints: (listener: typeof mockHint) => {
      mockHint = listener;
      return { remove: mockRemove };
    },
  },
}));

const api = { updateDevicePushToken: jest.fn(async () => {}) };
let binding: string | null = "account-a";
const sessionBinding = () => binding;
function Probe() {
  return <Text>{usePushWakeStatus()}</Text>;
}
const hint = {
  type: "crewroll.sync.v1",
  deviceId: "device-a",
  tripId: "trip-a",
  eventId: "event-a",
};
beforeEach(() => {
  jest.clearAllMocks();
  mockScope = { opaqueAccountScope: "scope-a", deviceId: "device-a" };
  binding = "account-a";
  AppState.currentState = "active";
});

it("reports missing provider configuration separately from session readiness", async () => {
  await render(
    <PushWakeProvider api={api} sessionBinding={sessionBinding}>
      <Probe />
    </PushWakeProvider>,
  );
  expect(screen.getByText("UNAVAILABLE")).toBeTruthy();
  expect(api.updateDevicePushToken).not.toHaveBeenCalled();
});

it("invalidates only current foreground account/device queries and ignores late old-account hints", async () => {
  const view = await render(
    <PushWakeProvider api={api} sessionBinding={sessionBinding}>
      <Probe />
    </PushWakeProvider>,
  );
  const originalListener = mockHint;
  await act(async () => {
    originalListener?.({ ...hint, deviceId: "other-device" });
  });
  expect(mockInvalidate).not.toHaveBeenCalled();
  await act(async () => {
    originalListener?.(hint);
    originalListener?.(hint);
    originalListener?.({ ...hint, eventId: "another-event" });
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(mockInvalidate.mock.calls.map(([input]) => input)).toEqual([
    { queryKey: ["trip-library", "scope-a", "device-a"], exact: true },
    { queryKey: ["trip", "scope-a", "device-a", "trip-a"], exact: true },
  ]);
  mockInvalidate.mockClear();
  binding = "account-b";
  await act(async () => {
    originalListener?.(hint);
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(mockInvalidate).not.toHaveBeenCalled();
  mockScope = null;
  await view.rerender(
    <PushWakeProvider api={api} sessionBinding={sessionBinding}>
      <Probe />
    </PushWakeProvider>,
  );
  await act(async () => {
    originalListener?.(hint);
  });
  expect(mockInvalidate).not.toHaveBeenCalled();
  expect(screen.getByText("IDLE")).toBeTruthy();
});

it("does not start foreground query work while backgrounded", async () => {
  await render(
    <PushWakeProvider api={api} sessionBinding={sessionBinding}>
      <Probe />
    </PushWakeProvider>,
  );
  AppState.currentState = "background";
  await act(async () => {
    mockHint?.(hint);
  });
  expect(mockInvalidate).not.toHaveBeenCalled();
});
