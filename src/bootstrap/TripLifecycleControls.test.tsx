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
  expect(view.queryByRole("button", { name: "End trip" })).toBeNull();
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
  expect(
    view.getByText("Finishing sync · 2 to save · 1 arriving"),
  ).toBeOnTheScreen();
  await fireEvent.press(view.getByRole("button", { name: "Leave now" }));
  expect(view.getByText("Leave without finishing?")).toBeOnTheScreen();
  expect(mockChange).toHaveBeenCalledTimes(1);
  expect(view.queryByRole("button", { name: "Stay in trip" })).toBeNull();
  await fireEvent.press(view.getByRole("button", { name: "Keep syncing" }));
  expect(
    view.getByText("Finishing sync · 2 to save · 1 arriving"),
  ).toBeOnTheScreen();
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
    expect(view.getByRole("button", { name: "End trip" })).toBeEnabled(),
  );
  await fireEvent.press(view.getByRole("button", { name: "End trip" }));
  expect(mockChange).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole("button", { name: "End trip" }));
  expect(mockChange).toHaveBeenCalledWith("trip", {
    action: "END",
    expectedVersion: 3,
  });
});

it.each(["ENDING", "COMPLETE", "INCOMPLETE_EXPIRED", "CANCELLED"] as const)(
  "keeps host controls visible and disabled for a %s trip",
  async (status) => {
    mockGet.mockResolvedValue({
      ...initial,
      status,
      participation: status === "ENDING" ? "LEAVING" : "LEFT",
      pendingUploads: 0,
      pendingDownloads: 0,
    });
    const view = await setup(true);
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Pause my sharing" }),
      ).toBeDisabled(),
    );
    const end = view.getByRole("button", { name: "End trip" });
    expect(end).toBeDisabled();
    await fireEvent.press(
      view.getByRole("button", { name: "Pause my sharing" }),
    );
    await fireEvent.press(end);
    expect(mockChange).not.toHaveBeenCalled();
    expect(view.queryByTestId("trip-exit-confirmation")).toBeNull();
    expect(view.queryByText("Waiting for the crew’s final photos.")).toBeNull();
    expect(view.queryByRole("button", { name: "Leave now" })).toBeNull();
  },
);

it("disables guest resume and leave controls after the trip finishes", async () => {
  mockGet.mockResolvedValue({
    ...initial,
    status: "COMPLETE",
    participation: "LEFT",
    sharingPaused: true,
  });
  const view = await setup();
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "Resume my sharing" }),
    ).toBeDisabled(),
  );
  const leave = view.getByRole("button", { name: "Leave trip" });
  expect(leave).toBeDisabled();
  await fireEvent.press(
    view.getByRole("button", { name: "Resume my sharing" }),
  );
  await fireEvent.press(leave);
  expect(mockChange).not.toHaveBeenCalled();
  expect(view.queryByTestId("trip-exit-confirmation")).toBeNull();
});
