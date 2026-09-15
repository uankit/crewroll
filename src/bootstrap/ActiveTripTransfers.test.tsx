import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { CrewRollThemeProvider } from "../design-system";
import { crewRollTransfer } from "../infrastructure/native/crewRollTransfer";
import { ActiveTripTransfers } from "./ActiveTripTransfers";

jest.mock("react-native-safe-area-context", () =>
  jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

jest.mock("../infrastructure/native/crewRollTransfer", () => ({
  crewRollTransfer: {
    getSnapshot: jest.fn(),
    listAssets: jest.fn(),
    reconcileNow: jest.fn(),
    retry: jest.fn(),
    setTransferPolicy: jest.fn().mockResolvedValue(undefined),
    subscribeToInvalidations: jest.fn(() => ({ remove: jest.fn() })),
  },
}));
const tripId = "01990000-0000-7000-8000-000000000001";
const workId = "01990000-0000-4000-8000-000000000002";
const snapshot = {
  protocolVersion: 1 as const,
  revision: 1,
  activeTripId: tripId,
  paused: false,
  counts: { discovered: 4, previewReady: 3, originalsSaved: 2, blocked: 0 },
  blockers: [],
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(crewRollTransfer.getSnapshot).mockResolvedValue(snapshot);
  jest.mocked(crewRollTransfer.listAssets).mockResolvedValue({
    protocolVersion: 1,
    revision: 1,
    items: [],
    nextCursor: null,
  });
});
const screen = () =>
  render(
    <CrewRollThemeProvider>
      <ActiveTripTransfers tripId={tripId} />
    </CrewRollThemeProvider>,
  );

it("shows verified local progress without claiming all-member delivery", async () => {
  const view = await screen();
  expect(
    await view.findByText(/2 of 4 originals saved on this phone/),
  ).toBeTruthy();
  expect(view.getByText(/Each phone shows its own progress/)).toBeTruthy();
  await fireEvent.press(
    view.getByRole("button", { name: "Check for photos now" }),
  );
  await waitFor(() =>
    expect(crewRollTransfer.reconcileNow).toHaveBeenCalledWith({
      protocolVersion: 1,
    }),
  );
});
it("renders a native preview while the original is pending and limits each page", async () => {
  jest.mocked(crewRollTransfer.listAssets).mockResolvedValue({
    activeTripId: tripId,
    protocolVersion: 1,
    revision: 1,
    nextCursor: null,
    items: [
      {
        workId,
        assetId: workId,
        capturedAt: "2026-09-08T12:00:00.000Z",
        previewStage: "SAVED",
        originalStage: "PENDING",
        previewUri: "file:///private/verified/preview.jpg",
        blocker: null,
      },
    ],
  });
  const view = await screen();
  expect(await view.findByTestId("trip-photo-gallery")).toBeTruthy();
  expect(view.getByText("Saving original…")).toBeTruthy();
  expect(crewRollTransfer.listAssets).toHaveBeenCalledWith({
    protocolVersion: 1,
    cursor: null,
    limit: 24,
  });
  await fireEvent.press(
    view.getByRole("button", { name: "Trip photo. Saving original…" }),
  );
  expect(await view.findByRole("button", { name: "Close photo" })).toBeTruthy();
  await fireEvent.press(view.getByRole("button", { name: "Close photo" }));
  expect(view.queryByRole("button", { name: "Close photo" })).toBeNull();
});
it("does not render another trip's progress", async () => {
  jest.mocked(crewRollTransfer.getSnapshot).mockResolvedValue({
    ...snapshot,
    activeTripId: "01990000-0000-7000-8000-000000000099",
  });
  const view = await screen();
  expect(await view.findByText("Photo delivery needs attention")).toBeTruthy();
  expect(view.queryByTestId("active-photo-progress")).toBeNull();
});
it("uses mobile data only after explicit consent on this phone", async () => {
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockResolvedValue({ ...snapshot, cellularAllowed: false });
  const view = await screen();
  expect(crewRollTransfer.setTransferPolicy).not.toHaveBeenCalled();
  await fireEvent.press(
    await view.findByRole("button", {
      name: "Allow mobile data (uses your data plan)",
    }),
  );
  await waitFor(() =>
    expect(crewRollTransfer.setTransferPolicy).toHaveBeenCalledWith({
      protocolVersion: 1,
      paused: false,
      cellularAllowed: true,
    }),
  );
});
it("rejects a photo page when the active trip changes between native reads", async () => {
  jest.mocked(crewRollTransfer.listAssets).mockResolvedValue({
    protocolVersion: 1,
    revision: 1,
    nextCursor: null,
    activeTripId: "01990000-0000-7000-8000-000000000099",
    items: [
      {
        workId,
        assetId: workId,
        capturedAt: "2026-09-08T12:00:00.000Z",
        previewStage: "SAVED",
        originalStage: "PENDING",
        previewUri: "file:///private/verified/preview.jpg",
        blocker: null,
      },
    ],
  });
  const view = await screen();
  expect(await view.findByText("Photo delivery needs attention")).toBeTruthy();
  expect(view.queryByTestId("trip-photo-gallery")).toBeNull();
});
it("fails visibly when the native engine is unavailable", async () => {
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockRejectedValue(new Error("native unavailable"));
  const view = await screen();
  expect(
    await view.findByRole("button", { name: "Refresh photo status" }),
  ).toBeTruthy();
  expect(view.queryByText("Sharing active")).toBeNull();
});
it("keeps the trip route alive when the native event bridge is missing", async () => {
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockRejectedValue(new Error("native unavailable"));
  jest
    .mocked(crewRollTransfer.subscribeToInvalidations)
    .mockImplementationOnce(() => {
      throw new Error("native unavailable");
    });
  const view = await screen();
  expect(
    await view.findByRole("button", { name: "Refresh photo status" }),
  ).toBeTruthy();
});
it("retries a blocked photo using its durable work identifier", async () => {
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockResolvedValue({ ...snapshot, blockers: ["STORAGE_FULL"] });
  jest.mocked(crewRollTransfer.listAssets).mockResolvedValue({
    protocolVersion: 1,
    revision: 1,
    nextCursor: null,
    items: [
      {
        workId,
        assetId: workId,
        capturedAt: "2026-09-08T12:00:00.000Z",
        previewStage: "PENDING",
        originalStage: "PENDING",
        blocker: "STORAGE_FULL",
      },
    ],
  });
  const view = await screen();
  await fireEvent.press(
    await view.findByRole("button", { name: "Retry blocked photo 1" }),
  );
  await waitFor(() =>
    expect(crewRollTransfer.retry).toHaveBeenCalledWith({
      protocolVersion: 1,
      workId,
    }),
  );
});
