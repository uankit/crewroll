import { TripInfoSheet } from "./TripInfoSheet";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { CrewRollThemeProvider } from "../design-system";
import { crewRollTransfer } from "../infrastructure/native/crewRollTransfer";
import { ActiveTripTransfers } from "./ActiveTripTransfers";
import { createTripGalleryCache } from "./tripGalleryCache";
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
afterEach(() => jest.useRealTimers());
const screen = () =>
  render(
    <CrewRollThemeProvider>
      <ActiveTripTransfers tripId={tripId} />
    </CrewRollThemeProvider>,
  );

const cachedPhotos = {
  snapshot,
  assets: {
    protocolVersion: 1 as const,
    activeTripId: tripId,
    revision: 1,
    nextCursor: null,
    items: [
      {
        workId,
        assetId: workId,
        capturedAt: "2026-09-08T12:00:00.000Z",
        previewStage: "SAVED" as const,
        originalStage: "SAVED" as const,
        previewUri: "file:///private/verified/preview.jpg",
        blocker: null,
      },
    ],
  },
};

it("recovers the permission handoff without showing an error or requiring a tap", async () => {
  jest.useFakeTimers();
  jest.mocked(crewRollTransfer.getSnapshot).mockResolvedValueOnce({
    ...snapshot,
    blockers: ["PHOTO_PERMISSION"],
  });
  const view = await screen();
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
  await act(async () => jest.advanceTimersByTimeAsync(500));
  view.getByText("Your roll starts here.");
  expect(view.queryByRole("alert")).toBeNull();
  expect(crewRollTransfer.getSnapshot).toHaveBeenCalledTimes(2);
});

it("automatically retries a transient native read and cancels retries when leaving", async () => {
  jest.useFakeTimers();
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockRejectedValueOnce(new Error("native session changing"));
  const view = await screen();
  expect(view.queryByRole("alert")).toBeNull();
  await act(async () => jest.advanceTimersByTimeAsync(500));
  view.getByText("Your roll starts here.");
  expect(view.queryByRole("alert")).toBeNull();
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockRejectedValueOnce(new Error("native session changing"));
  const notify = jest
    .mocked(crewRollTransfer.subscribeToInvalidations)
    .mock.calls.at(-1)![0];
  await act(async () =>
    notify({ protocolVersion: 1, type: "ENGINE_INVALIDATED", revision: 2 }),
  );
  await view.unmount();
  await act(async () => jest.advanceTimersByTimeAsync(20_000));
  expect(crewRollTransfer.getSnapshot).toHaveBeenCalledTimes(3);
});

it("bounds automatic retries and reports persistent permission problems accurately", async () => {
  jest.useFakeTimers();
  const cache = createTripGalleryCache(tripId);
  cache.save(cache.token(), cachedPhotos);
  jest.mocked(crewRollTransfer.getSnapshot).mockResolvedValue({
    ...snapshot,
    blockers: ["PHOTO_PERMISSION"],
  });
  const view = await render(
    <CrewRollThemeProvider>
      <ActiveTripTransfers tripId={tripId} cache={cache} />
    </CrewRollThemeProvider>,
  );
  expect(view.queryByTestId("trip-photo-gallery")).toBeNull();
  expect(cache.getSnapshot().data).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
  await act(async () => jest.advanceTimersByTimeAsync(2000));
  view.getByText(
    "Allow full photo access in Settings, including original metadata access on Android, then retry.",
  );
  view.getByRole("button", { name: "Try again" });
  expect(view.queryByText(/Check your connection/)).toBeNull();
  await act(async () => jest.advanceTimersByTimeAsync(5000));
  expect(crewRollTransfer.getSnapshot).toHaveBeenCalledTimes(3);
});

it("does not retry after the account cache has been retired", async () => {
  jest.useFakeTimers();
  const cache = createTripGalleryCache(tripId);
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockRejectedValueOnce(new Error("native session changing"));
  await render(
    <CrewRollThemeProvider>
      <ActiveTripTransfers tripId={tripId} cache={cache} />
    </CrewRollThemeProvider>,
  );
  await act(async () => cache.dispose());
  await act(async () => jest.advanceTimersByTimeAsync(2000));
  expect(crewRollTransfer.getSnapshot).toHaveBeenCalledTimes(1);
});

it("restores photos on re-entry before a fresh native read finishes", async () => {
  const cache = createTripGalleryCache(tripId);
  jest
    .mocked(crewRollTransfer.listAssets)
    .mockResolvedValueOnce(cachedPhotos.assets);
  const first = await render(
    <CrewRollThemeProvider>
      <ActiveTripTransfers tripId={tripId} cache={cache} />
    </CrewRollThemeProvider>,
  );
  await first.findByTestId("trip-photo-gallery");
  cache.saveScrollY(410);
  await first.unmount();
  let complete!: (value: typeof snapshot) => void;
  jest.mocked(crewRollTransfer.getSnapshot).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const reopened = await render(
    <CrewRollThemeProvider>
      <ActiveTripTransfers tripId={tripId} cache={cache} />
    </CrewRollThemeProvider>,
  );
  reopened.getByTestId("trip-photo-gallery");
  expect(reopened.queryByText("Loading photos…")).toBeNull();
  expect(cache.getScrollY()).toBe(410);
  await act(async () => complete(snapshot));
  expect(crewRollTransfer.listAssets).toHaveBeenCalledTimes(1);
});

it("updates cached photos from native events and preserves them through a transient read failure", async () => {
  const cache = createTripGalleryCache(tripId);
  cache.save(cache.token(), cachedPhotos);
  const view = await render(
    <CrewRollThemeProvider>
      <ActiveTripTransfers tripId={tripId} cache={cache} />
    </CrewRollThemeProvider>,
  );
  const notify = jest
    .mocked(crewRollTransfer.subscribeToInvalidations)
    .mock.calls.at(-1)![0];
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockRejectedValueOnce(new Error("temporary read failure"));
  await act(async () =>
    notify({ protocolVersion: 1, type: "ENGINE_INVALIDATED", revision: 2 }),
  );
  view.getByTestId("trip-photo-gallery");
  expect(view.queryByText("Loading photos…")).toBeNull();
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockResolvedValue({ ...snapshot, revision: 2 });
  jest.mocked(crewRollTransfer.listAssets).mockResolvedValue({
    ...cachedPhotos.assets,
    revision: 2,
    items: [
      ...cachedPhotos.assets.items,
      {
        ...cachedPhotos.assets.items[0]!,
        assetId: "second-photo",
        workId: "second-work",
      },
    ],
  });
  await act(async () =>
    notify({ protocolVersion: 1, type: "ENGINE_INVALIDATED", revision: 2 }),
  );
  expect(
    view.getAllByRole("button", { name: "Trip photo. Saved on this phone" }),
  ).toHaveLength(2);
});

it("clears cached previews on revoked access and ignores a read started before clearing", async () => {
  const cache = createTripGalleryCache(tripId);
  cache.save(cache.token(), cachedPhotos);
  let complete!: (value: typeof snapshot) => void;
  jest.mocked(crewRollTransfer.getSnapshot).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const view = await render(
    <CrewRollThemeProvider>
      <ActiveTripTransfers tripId={tripId} cache={cache} />
    </CrewRollThemeProvider>,
  );
  view.getByTestId("trip-photo-gallery");
  await act(async () => cache.clear());
  await act(async () => complete(snapshot));
  expect(view.queryByTestId("trip-photo-gallery")).toBeNull();
  expect(cache.getSnapshot().data).toBeNull();
  const notify = jest
    .mocked(crewRollTransfer.subscribeToInvalidations)
    .mock.calls.at(-1)![0];
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockResolvedValue({ ...snapshot, blockers: ["PHOTO_PERMISSION"] });
  await act(async () =>
    notify({ protocolVersion: 1, type: "ENGINE_INVALIDATED", revision: 2 }),
  );
  expect(view.queryByTestId("trip-photo-gallery")).toBeNull();
});

it("does not reuse a different account cache or keep polling while the route is hidden", async () => {
  const first = createTripGalleryCache(tripId);
  first.save(first.token(), cachedPhotos);
  const nextAccount = createTripGalleryCache(tripId);
  const view = await render(
    <CrewRollThemeProvider>
      <ActiveTripTransfers tripId={tripId} cache={first} focused={false} />
    </CrewRollThemeProvider>,
  );
  view.getByTestId("trip-photo-gallery");
  expect(crewRollTransfer.getSnapshot).not.toHaveBeenCalled();
  await view.rerender(
    <CrewRollThemeProvider>
      <ActiveTripTransfers
        tripId={tripId}
        cache={nextAccount}
        focused={false}
      />
    </CrewRollThemeProvider>,
  );
  expect(view.queryByTestId("trip-photo-gallery")).toBeNull();
  expect(crewRollTransfer.getSnapshot).not.toHaveBeenCalled();
});

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
    await view.findByText("Couldn’t load photos yet. Try again."),
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
    await view.findByText("Couldn’t load photos yet. Try again."),
  ).toBeTruthy();
  expect(view.queryByTestId("trip-photo-gallery")).toBeNull();
});
it("fails visibly when the native engine is unavailable", async () => {
  jest.useFakeTimers();
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockRejectedValue(new Error("native unavailable"));
  const view = await screen();
  await act(async () => jest.advanceTimersByTimeAsync(2000));
  expect(await view.findByRole("button", { name: "Try again" })).toBeTruthy();
  expect(view.queryByText("Sharing active")).toBeNull();
});
it("keeps the trip route alive when the native event bridge is missing", async () => {
  jest.useFakeTimers();
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockRejectedValue(new Error("native unavailable"));
  jest
    .mocked(crewRollTransfer.subscribeToInvalidations)
    .mockImplementationOnce(() => {
      throw new Error("native unavailable");
    });
  const view = await screen();
  await act(async () => jest.advanceTimersByTimeAsync(2000));
  expect(await view.findByRole("button", { name: "Try again" })).toBeTruthy();
});
it("retries the whole trip rather than just the blocked photo on the current page", async () => {
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
  await fireEvent.press(await view.findByRole("button", { name: "Sync now" }));
  await waitFor(() =>
    expect(crewRollTransfer.reconcileNow).toHaveBeenCalledWith({
      protocolVersion: 1,
    }),
  );
  expect(crewRollTransfer.retry).not.toHaveBeenCalled();
});

it("keeps sync and network selection out of trip info", async () => {
  const view = await render(
    <CrewRollThemeProvider>
      <TripInfoSheet
        trip={tripInfo}
        onDismiss={() => {}}
        onChanged={() => {}}
      />
    </CrewRollThemeProvider>,
  );
  expect(view.queryByRole("button", { name: "Sync now" })).toBeNull();
  expect(view.queryByText("Allow mobile data")).toBeNull();
  expect(view.queryByText("Use Wi-Fi only")).toBeNull();
  expect(crewRollTransfer.getSnapshot).not.toHaveBeenCalled();
  expect(crewRollTransfer.setTransferPolicy).not.toHaveBeenCalled();
});

it("lets the gallery sync an empty roll and coalesces repeated taps", async () => {
  let finish!: () => void;
  jest.mocked(crewRollTransfer.reconcileNow).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const view = await screen();
  const button = await view.findByRole("button", { name: "Sync now" });
  await fireEvent.press(button);
  await fireEvent.press(button);
  await waitFor(() =>
    expect(crewRollTransfer.reconcileNow).toHaveBeenCalledTimes(1),
  );
  expect(crewRollTransfer.reconcileNow).toHaveBeenCalledWith({
    protocolVersion: 1,
  });
  expect(crewRollTransfer.setTransferPolicy).not.toHaveBeenCalled();
  await act(async () => finish());
});

it("does not sync a different trip after a native session change", async () => {
  const view = await screen();
  const button = await view.findByRole("button", { name: "Sync now" });
  jest
    .mocked(crewRollTransfer.getSnapshot)
    .mockResolvedValue({ ...snapshot, activeTripId: null });
  await fireEvent.press(button);
  expect(crewRollTransfer.reconcileNow).not.toHaveBeenCalled();
  expect(crewRollTransfer.setTransferPolicy).not.toHaveBeenCalled();
});
it("releases a stalled sync button and ignores a late native read", async () => {
  jest.useFakeTimers();
  const view = await screen();
  let finish!: (value: typeof snapshot) => void;
  jest.mocked(crewRollTransfer.getSnapshot).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await fireEvent.press(await view.findByRole("button", { name: "Sync now" }));
  await act(async () => jest.advanceTimersByTimeAsync(10_000));
  expect(view.getByText("Couldn’t start sync yet. Try again.")).toBeTruthy();
  expect(
    view.getByRole("button", { name: "Sync now" }).props.accessibilityState
      ?.busy,
  ).toBe(false);
  await act(async () => finish(snapshot));
  expect(crewRollTransfer.reconcileNow).not.toHaveBeenCalled();
});

it("keeps the gallery available when a manual sync cannot connect", async () => {
  jest
    .mocked(crewRollTransfer.reconcileNow)
    .mockRejectedValueOnce(new Error("offline"));
  const view = await screen();
  await fireEvent.press(await view.findByRole("button", { name: "Sync now" }));
  expect(
    await view.findByText("Couldn’t start sync yet. Try again."),
  ).toBeTruthy();
  expect(view.getByText("Your roll starts here.")).toBeTruthy();
  expect(view.getByRole("button", { name: "Sync now" })).toBeTruthy();
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
