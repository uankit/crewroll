import type { DurableEngineSnapshot } from "@crewroll/contracts/native/protocol";

/** This phone's verified work; a server queue ACK is never a photo-save count. */
export function syncProgress(
  snapshot: DurableEngineSnapshot,
  now = Date.now(),
): string {
  const sync = snapshot.sync;
  const queued = Math.max(
    0,
    snapshot.counts.discovered - snapshot.counts.originalsSaved,
  );
  if (!sync)
    return queued > 0
      ? `${queued} ${queued === 1 ? "photo" : "photos"} queued`
      : "Photos sync automatically";
  if (sync.state === "PAUSED") return "Sync paused";
  if (sync.uploadsActive && sync.downloadsActive)
    return "Uploading and saving photos…";
  if (sync.uploadsActive)
    return `Uploading ${sync.uploadsPending} ${sync.uploadsPending === 1 ? "photo" : "photos"}…`;
  if (sync.downloadsActive)
    return `Saving ${sync.downloadsPending} ${sync.downloadsPending === 1 ? "photo" : "photos"}…`;
  if (sync.state === "WAITING_NETWORK") return "Waiting for internet";
  if (sync.state === "NEEDS_ATTENTION") return "Photo sync needs attention";
  if (sync.nextRetryAt) {
    const seconds = Math.max(
      0,
      Math.ceil((Date.parse(sync.nextRetryAt) - now) / 1000),
    );
    return seconds > 0 ? `Retrying in ${seconds}s` : "Retrying photos…";
  }
  if (queued > 0)
    return `${queued} ${queued === 1 ? "photo" : "photos"} waiting to sync`;
  if (!sync.lastCheckedAt) return "Checking for photos…";
  return "Up to date on this phone";
}
