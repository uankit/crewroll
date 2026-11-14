import { act, fireEvent, render } from "@testing-library/react-native";
import type { TripSummary } from "../../domain/trips/model";
import { TripLibraryScreen } from "./TripLibraryScreen";

// Use the real recycler and the measurement pattern from its Jest setup.
// These are rendering/interaction checks, not physical-device performance claims.
jest.mock("@shopify/flash-list/dist/recyclerview/utils/measureLayout", () => ({
  ...jest.requireActual(
    "@shopify/flash-list/dist/recyclerview/utils/measureLayout",
  ),
  measureParentSize: () => ({ x: 0, y: 0, width: 400, height: 900 }),
  measureFirstChildLayout: () => ({ x: 0, y: 0, width: 400, height: 900 }),
  measureItemLayout: () => ({ x: 0, y: 0, width: 400, height: 100 }),
}));

const history: TripSummary[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: `018f22c4-6e80-7000-8000-${String(index).padStart(12, "0")}`,
  name: `Past trip ${index}`,
  status: "COMPLETE",
  participation: "LEFT",
  role: "MEMBER",
  startsAt: "2030-01-01T00:00:00.000Z",
  endsAt: "2030-01-02T00:00:00.000Z",
  leftAt: "2030-01-02T00:00:00.000Z",
  sharingPaused: false,
  onThisDevice: true,
  memberCount: 2,
  savedPhotoCount: index,
}));

it("recycles a large history while keeping creation and rendered trip actions accessible", async () => {
  const onOpenTrip = jest.fn();
  const onCreateTrip = jest.fn();
  const screen = await render(
    <TripLibraryScreen
      trips={history}
      onOpenTrip={onOpenTrip}
      onCreateTrip={onCreateTrip}
      onJoinTrip={jest.fn()}
      onRetry={jest.fn()}
    />,
  );
  const mounted = screen
    .getAllByRole("button")
    .filter((button) =>
      String(button.props.accessibilityLabel).startsWith("View Past trip"),
    );
  expect(mounted.length).toBeGreaterThan(0);
  expect(mounted.length).toBeLessThan(100);
  expect(screen.queryByTestId("trip-library-screen-scroll")).toBeNull();
  await fireEvent.press(
    screen.getByRole("button", { name: "View Past trip 0" }),
  );
  expect(onOpenTrip).toHaveBeenCalledWith(history[0]);
  await fireEvent.press(
    screen.getByRole("button", { name: "Start a new trip" }),
  );
  expect(onCreateTrip).toHaveBeenCalledTimes(1);
  await fireEvent.scroll(screen.getByTestId("trip-history-list"), {
    nativeEvent: {
      contentOffset: { x: 0, y: 90_000 },
      contentSize: { width: 400, height: 100_900 },
      layoutMeasurement: { width: 400, height: 900 },
    },
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  const later = screen
    .getAllByRole("button")
    .find((button) =>
      /^View Past trip 9\d\d$/.test(String(button.props.accessibilityLabel)),
    );
  expect(later).toBeDefined();
  if (!later) throw new Error("Expected an older trip after scrolling");
  await fireEvent.press(later);
  expect(onOpenTrip).toHaveBeenCalledTimes(2);
});

it("keeps the current trip and retry state when history refresh fails", async () => {
  const current = {
    ...history[0]!,
    id: "018f22c4-6e80-7000-8000-999999999999",
    name: "Current trip",
    status: "ACTIVE" as const,
    participation: "JOINED" as const,
    leftAt: null,
  };
  const onOpenTrip = jest.fn();
  const onRetry = jest.fn();
  const screen = await render(
    <TripLibraryScreen
      trips={[current, ...history]}
      error
      onOpenTrip={onOpenTrip}
      onCreateTrip={jest.fn()}
      onJoinTrip={jest.fn()}
      onRetry={onRetry}
    />,
  );
  await fireEvent.press(
    screen.getByRole("button", { name: "Open Current trip" }),
  );
  expect(onOpenTrip).toHaveBeenCalledWith(current);
  await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Start a new trip" }),
  ).toBeDisabled();
});
