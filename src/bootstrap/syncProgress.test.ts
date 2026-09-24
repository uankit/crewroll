import type { DurableEngineSnapshot } from "@crewroll/contracts/native/protocol";
import { syncProgress } from "./syncProgress";

const snapshot: DurableEngineSnapshot = {
  protocolVersion: 1,
  revision: 1,
  activeTripId: null,
  paused: false,
  cellularAllowed: true,
  counts: {
    discovered: 100,
    previewReady: 100,
    originalsSaved: 24,
    blocked: 1,
  },
  blockers: [],
  sync: {
    state: "TRANSFERRING",
    uploadsActive: 1,
    downloadsActive: 2,
    uploadsPending: 10,
    downloadsPending: 66,
    lastProgressAt: null,
    lastCheckedAt: "2026-09-18T00:00:00Z",
    nextRetryAt: null,
  },
};
it("describes independent work on this phone without claiming global completion", () => {
  expect(syncProgress(snapshot)).toBe("Uploading and saving photos…");
  expect(
    syncProgress({
      ...snapshot,
      counts: { ...snapshot.counts, originalsSaved: 100 },
      sync: {
        ...snapshot.sync!,
        state: "IDLE",
        uploadsActive: 0,
        downloadsActive: 0,
      },
    }),
  ).toBe("Up to date on this phone");
});
it("shows known network waits and retry deadlines while retaining queued counts", () => {
  expect(
    syncProgress({
      ...snapshot,
      sync: {
        ...snapshot.sync!,
        state: "WAITING_NETWORK",
        uploadsActive: 0,
        downloadsActive: 0,
      },
    }),
  ).toBe("Waiting for internet");
  expect(
    syncProgress(
      {
        ...snapshot,
        sync: {
          ...snapshot.sync!,
          state: "RETRYING",
          uploadsActive: 0,
          downloadsActive: 0,
          nextRetryAt: "2026-09-18T00:00:05Z",
        },
      },
      Date.parse("2026-09-18T00:00:02Z"),
    ),
  ).toBe("Retrying in 3s");
});
