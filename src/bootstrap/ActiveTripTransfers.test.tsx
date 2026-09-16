import { TripInfoSheet } from "./TripInfoSheet";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { CrewRollThemeProvider } from "../design-system";
import { crewRollTransfer } from "../infrastructure/native/crewRollTransfer";
import { ActiveTripTransfers } from "./ActiveTripTransfers";
import type { TripView } from "../domain/trips/model";
jest.mock("./TripContinuityControls", () => ({
  TripContinuityControls: () => null,
}));
jest.mock("./TripLifecycleControls", () => ({
  TripLifecycleControls: () => null,
}));

jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
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
const tripInfo: TripView = {
  id: tripId,
  version: 1,
  name: "Goa weekend",
  status: "ACTIVE",
  release: { mode: "IMMEDIATE" },
  startsAt: "2026-09-16T05:00:00.000Z",
  endsAt: "2026-09-18T05:00:00.000Z",
  ownerDeviceId: "01990000-0000-7000-8000-000000000003",
  currentMembershipId: "01990000-0000-7000-8000-000000000004",
  members: [],
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

it("does not treat an empty roll as loading or as a saved photo", async () => {
  const view = await screen();
  await waitFor(() => expect(crewRollTransfer.listAssets).toHaveBeenCalled());
  expect(view.queryByTestId("active-photo-progress")).toBeNull();
  expect(view.queryByTestId("trip-photo-gallery")).toBeNull();
  expect(crewRollTransfer.setTransferPolicy).not.toHaveBeenCalled();
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
  expect(view.queryByText("Saving original…")).toBeNull();
  expect(view.queryByTestId("active-photo-progress")).toBeNull();
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
  expect(
    await view.findByText(
      "Photos couldn’t refresh. Check your connection and try again.",
    ),
  ).toBeTruthy();
  expect(view.queryByTestId("active-photo-progress")).toBeNull();
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
  expect(
    await view.findByText(
      "Photos couldn’t refresh. Check your connection and try again.",
    ),
  ).toBeTruthy();
  expect(view.queryByTestId("trip-photo-gallery")).toBeNull();
});
it("fails visibly when the native engine is unavailable", async () => {
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockRejectedValue(new Error("native unavailable"));
  const view = await screen();
  expect(await view.findByRole("button", { name: "Try again" })).toBeTruthy();
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
  expect(await view.findByRole("button", { name: "Try again" })).toBeTruthy();
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
    await view.findByRole("button", { name: "Retry photo sharing" }),
  );
  await waitFor(() =>
    expect(crewRollTransfer.retry).toHaveBeenCalledWith({
      protocolVersion: 1,
      workId,
    }),
  );
});

it("changes connection policy only after a deliberate choice in trip info", async () => {
  jest.mocked(crewRollTransfer.getSnapshot).mockResolvedValue({
    ...snapshot,
    cellularAllowed: false,
  });
  const view = await render(
    <CrewRollThemeProvider>
      <TripInfoSheet
        trip={tripInfo}
        onDismiss={() => {}}
        onChanged={() => {}}
      />
    </CrewRollThemeProvider>,
  );
  const button = await view.findByRole("button", { name: "Allow mobile data" });
  expect(crewRollTransfer.setTransferPolicy).not.toHaveBeenCalled();
  await fireEvent.press(button);
  await waitFor(() =>
    expect(crewRollTransfer.setTransferPolicy).toHaveBeenCalledWith({
      protocolVersion: 1,
      paused: false,
      cellularAllowed: true,
    }),
  );
});

it("passes photographer and sort filters to native and exposes a clear empty result", async () => {
  const onClearFilters = jest.fn();
  const view = await render(
    <CrewRollThemeProvider>
      <ActiveTripTransfers
        tripId={tripId}
        filters={{
          sourceMembershipId: tripInfo.currentMembershipId,
          day: null,
          order: "OLDEST",
        }}
        onClearFilters={onClearFilters}
      />
    </CrewRollThemeProvider>,
  );
  expect(await view.findByText("No photos for these filters")).toBeTruthy();
  expect(crewRollTransfer.listAssets).toHaveBeenCalledWith({
    protocolVersion: 1,
    cursor: null,
    limit: 24,
    sourceMembershipId: tripInfo.currentMembershipId,
    order: "OLDEST",
  });
  await fireEvent.press(view.getByRole("button", { name: "Clear filters" }));
  expect(onClearFilters).toHaveBeenCalledTimes(1);
});
