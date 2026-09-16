import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { TripTransferState } from "@crewroll/contracts";
import { CrewRollThemeProvider } from "../design-system";
import { TripLifecycleControls } from "./TripLifecycleControls";

const mockGet = jest.fn();
const mockChange = jest.fn();
const mockActions = {
  getTripLifecycle: mockGet,
  changeTripLifecycle: mockChange,
};
jest.mock("./AppSessionProvider", () => ({
  useAppSession: () => ({ actions: mockActions }),
}));
const initial: TripTransferState = {
  tripId: "trip",
  version: 3,
  status: "ACTIVE",
  participation: "JOINED",
  sharingPaused: false,
  captureUntil: "2030-01-01T00:00:00.000Z",
  excludedCaptureWindows: [],
  pendingUploads: 1,
  pendingDownloads: 2,
  deliveryDeadline: "2030-01-08T00:00:00.000Z",
};
const setup = (owner = false) =>
  render(
    <CrewRollThemeProvider>
      <TripLifecycleControls tripId="trip" owner={owner} />
    </CrewRollThemeProvider>,
  );
beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue(initial);
});
it("pauses personally without issuing a trip-wide end", async () => {
  mockChange.mockResolvedValue({ ...initial, sharingPaused: true, version: 4 });
  const view = await setup();
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "Pause my sharing" }),
    ).toBeOnTheScreen(),
  );
  await fireEvent.press(view.getByRole("button", { name: "Pause my sharing" }));
  expect(mockChange).toHaveBeenCalledWith("trip", {
    action: "PAUSE",
    expectedVersion: 3,
  });
  expect(
    view.getByRole("button", { name: "Resume my sharing" }),
  ).toBeOnTheScreen();
  expect(
    view.queryByRole("button", { name: "End trip for everyone" }),
  ).toBeNull();
});
it("requires confirmation, supports cancel, and defaults to finishing sync", async () => {
  mockChange.mockResolvedValue({
    ...initial,
    participation: "LEAVING",
    version: 4,
  });
  const view = await setup();
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Leave trip" })).toBeEnabled(),
  );
  await fireEvent.press(view.getByRole("button", { name: "Leave trip" }));
  expect(mockChange).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole("button", { name: "Stay in trip" }));
  expect(mockChange).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole("button", { name: "Leave trip" }));
  await fireEvent.press(
    view.getByRole("button", { name: "Finish syncing and leave" }),
  );
  expect(mockChange).toHaveBeenCalledWith("trip", {
    action: "LEAVE",
    expectedVersion: 3,
  });
  expect(view.getByText("Finishing sync before you leave")).toBeOnTheScreen();
  await fireEvent.press(
    view.getByRole("button", { name: "Leave now instead" }),
  );
  expect(view.getByText("Leave without finishing?")).toBeOnTheScreen();
  expect(mockChange).toHaveBeenCalledTimes(1);
  expect(view.queryByRole("button", { name: "Stay in trip" })).toBeNull();
  await fireEvent.press(view.getByRole("button", { name: "Keep syncing" }));
  expect(view.getByText("Finishing sync before you leave")).toBeOnTheScreen();
  expect(mockChange).toHaveBeenCalledTimes(1);
});
it("requires a separate host confirmation to end sharing for everyone", async () => {
  mockChange.mockResolvedValue({
    ...initial,
    participation: "LEAVING",
    status: "ENDING",
  });
  const view = await setup(true);
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "End trip for everyone" }),
    ).toBeEnabled(),
  );
  await fireEvent.press(
    view.getByRole("button", { name: "End trip for everyone" }),
  );
  expect(mockChange).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole("button", { name: "End trip" }));
  expect(mockChange).toHaveBeenCalledWith("trip", {
    action: "END",
    expectedVersion: 3,
  });
});
