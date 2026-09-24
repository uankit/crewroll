import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, StyleSheet, View } from "react-native";
import type { DurableEngineSnapshot } from "@crewroll/contracts/native/protocol";

import {
  AppText,
  Button,
  Stack,
  TripPhotoGallery,
  spacing,
} from "../design-system";
import { crewRollTransfer } from "../infrastructure/native/crewRollTransfer";
import {
  defaultGalleryFilters,
  galleryFilterCount,
  galleryQuery,
  type GalleryFilters,
} from "../domain/trips/galleryFilters";

import { createObservedRead } from "./observedRead";
import { syncProgress } from "./syncProgress";
import {
  createTripGalleryCache,
  type TripGalleryCache,
} from "./tripGalleryCache";

const blockerCopy: Record<DurableEngineSnapshot["blockers"][number], string> = {
  PHOTO_PERMISSION:
    "Allow full photo access in Settings, including original metadata access on Android, then retry.",
  STORAGE_FULL: "Free some space on this phone, then retry.",
  AUTH_REVOKED: "Sign in again to reconnect this phone.",
  SOURCE_MISSING: "The original photo is no longer available on this phone.",
  INTEGRITY_FAILURE:
    "A photo could not be verified. It has not been marked as saved.",
  KEY_ACCESS_LOCKED: "Unlock this phone, then retry.",
  KEY_MATERIAL_LOST: "This phone needs its secure trip access restored.",
  KEY_ENVELOPE_INVALID: "Secure trip access could not be verified.",
};
const galleryReadFailure = "Couldn’t load photos yet. Try again.";
const galleryRetryDelays = [500, 1500] as const;

/** Read-only native projections. Photo bytes and decryption keys never enter JS. */
export function ActiveTripTransfers({
  tripId,
  onPhotoCountChange,
  filters = defaultGalleryFilters,
  onClearFilters,
  cache: suppliedCache,
  focused = true,
}: Readonly<{
  tripId: string;
  onPhotoCountChange?: (count: number) => void;
  filters?: GalleryFilters;
  onClearFilters?: () => void;
  cache?: TripGalleryCache;
  focused?: boolean;
}>) {
  const cache = useMemo(
    () => suppliedCache ?? createTripGalleryCache(tripId),
    [suppliedCache, tripId],
  );
  const gallery = useSyncExternalStore(
    cache.subscribe,
    cache.getSnapshot,
    cache.getSnapshot,
  );
  const { data: state, cursor } = gallery;
  const setCursor = cache.setCursor;
  useLayoutEffect(() => {
    cache.setFilters(filters);
  }, [cache, filters]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const syncing = useRef(false);
  const syncAttempt = useRef(0);
  const mounted = useRef(true);
  const [syncError, setSyncError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(Date.now);
  const query = useMemo(() => galleryQuery(filters), [filters]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!focused || !state?.snapshot.sync?.nextRetryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [focused, state?.snapshot.sync?.nextRetryAt]);

  useEffect(() => {
    if (!focused) return;
    let readToken = cache.token();
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelRetry = () => {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const recover = (message: string) => {
      // Permission dialogs and native activation can briefly invalidate a read.
      // Retry locally before asking the user to fix a connection that is fine.
      if (retryTimer !== undefined) return;
      const delay = galleryRetryDelays[retryCount++];
      if (delay === undefined) {
        setFailure(message);
        return;
      }
      const token = cache.token();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (cache.accepts(token)) void reader.refresh();
      }, delay);
    };
    const reader = createObservedRead({
      active: () =>
        AppState.currentState !== "background" && cache.accepts(cache.token()),
      read: async () => {
        const token = cache.token();
        readToken = token;
        const previous = cache.getSnapshot().data;
        const snapshot = await crewRollTransfer.getSnapshot();
        // Native revisions include newly captured/received photos and transfers.
        // The unchanged page can stay visible without another listAssets read.
        const assets =
          previous &&
          previous.snapshot.revision === snapshot.revision &&
          previous.snapshot.activeTripId === snapshot.activeTripId &&
          previous.snapshot.paused === snapshot.paused &&
          JSON.stringify(previous.snapshot.blockers) ===
            JSON.stringify(snapshot.blockers)
            ? previous.assets
            : await crewRollTransfer.listAssets({
                protocolVersion: 1,
                cursor,
                limit: 24,
                ...query,
              });
        return { token, snapshot, assets };
      },
      ready: ({ token, snapshot, assets }) => {
        if (!cache.accepts(token)) return;
        cancelRetry();
        const accessBlocker = snapshot.blockers.find((blocker) =>
          [
            "PHOTO_PERMISSION",
            "AUTH_REVOKED",
            "KEY_ACCESS_LOCKED",
            "KEY_MATERIAL_LOST",
            "KEY_ENVELOPE_INVALID",
          ].includes(blocker),
        );
        if (accessBlocker) {
          cache.clear();
          // Never retain previews while access is blocked, including during
          // the short handoff after the OS has just granted photo permission.
          if (accessBlocker === "PHOTO_PERMISSION")
            recover(blockerCopy[accessBlocker]);
          else setFailure(blockerCopy[accessBlocker]);
          return;
        }
        if (!cache.save(token, { snapshot, assets })) {
          if (snapshot.activeTripId === null) recover(galleryReadFailure);
          else setFailure(galleryReadFailure);
          return;
        }
        retryCount = 0;
        setFailure(null);
      },
      failed: () => {
        if (!cache.accepts(readToken)) return;
        if (cursor !== null) setCursor(null);
        else recover(galleryReadFailure);
      },
    });
    const refresh = reader.refresh;
    void refresh();
    // Native events drive updates; this foreground-only fallback catches a
    // missed event without rebuilding the gallery every few seconds.
    const timer = setInterval(() => void refresh(), 15_000);
    let subscription:
      ReturnType<typeof crewRollTransfer.subscribeToInvalidations> | undefined;
    try {
      subscription = crewRollTransfer.subscribeToInvalidations(
        () => void refresh(),
      );
    } catch {
      // The fallback remains available if this installed event bridge is absent.
    }
    const foreground = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh();
    });
    return () => {
      reader.dispose();
      cancelRetry();
      clearInterval(timer);
      subscription?.remove();
      foreground.remove();
    };
  }, [tripId, cache, focused, refreshKey, cursor, query, setCursor]);

  const reconcile = useCallback(
    async (workId?: string) => {
      if (syncing.current) return;
      syncing.current = true;
      const attempt = ++syncAttempt.current;
      let expired = false;
      setBusy(true);
      setSyncError(false);
      const token = cache.token();
      const deadline = setTimeout(() => {
        expired = true;
        if (mounted.current && syncAttempt.current === attempt) {
          syncing.current = false;
          setBusy(false);
          setSyncError(true);
        }
      }, 10_000);
      try {
        const current = await crewRollTransfer.getSnapshot();
        if (
          expired ||
          !mounted.current ||
          !cache.accepts(token) ||
          current.activeTripId !== tripId
        )
          return;
        if (workId)
          await crewRollTransfer.retry({ protocolVersion: 1, workId });
        else {
          // Native owns the whole account/trip journal, including off-page work.
          if (!mounted.current || !cache.accepts(token)) return;
          await crewRollTransfer.reconcileNow({ protocolVersion: 1 });
        }
      } catch {
        if (mounted.current && syncAttempt.current === attempt)
          setSyncError(true);
      } finally {
        clearTimeout(deadline);
        if (syncAttempt.current === attempt) syncing.current = false;
        if (mounted.current && syncAttempt.current === attempt) {
          setBusy(false);
          setRefreshKey((value) => value + 1);
        }
      }
    },
    [tripId, cache],
  );

  const snapshot =
    state?.snapshot.activeTripId === tripId ? state.snapshot : null;
  const photos = useMemo(
    () =>
      snapshot && state
        ? state.assets.items.map((asset) => ({
            id: asset.assetId ?? asset.workId,
            previewUri: snapshot.paused ? null : (asset.previewUri ?? null),
            status: asset.blocker
              ? "Needs attention"
              : asset.originalStage === "SAVED"
                ? "Saved on this phone"
                : snapshot.paused
                  ? "Paused"
                  : asset.previewUri
                    ? "Saving original…"
                    : "Getting preview…",
          }))
        : [],
    [snapshot, state],
  );
  const discoveredCount = snapshot?.counts.discovered;
  useEffect(() => {
    if (discoveredCount !== undefined) onPhotoCountChange?.(discoveredCount);
  }, [onPhotoCountChange, discoveredCount]);
  if (snapshot === null)
    return (
      <>
        <Stack gap="sm" style={{ flex: 1 }}>
          {!failure ? (
            <AppText
              variant="caption"
              tone="secondary"
              accessibilityLiveRegion="polite"
            >
              Loading photos…
            </AppText>
          ) : null}
          {failure ? (
            <AppText accessibilityRole="alert" tone="critical">
              {failure}
            </AppText>
          ) : null}
          {failure ? (
            <Button
              label="Try again"
              onPress={() => {
                setFailure(null);
                setRefreshKey((value) => value + 1);
              }}
            />
          ) : null}
        </Stack>
      </>
    );
  const blocked = snapshot.blockers.length > 0;
  return (
    <>
      <Stack gap="sm" style={photos.length === 0 ? { flex: 1 } : undefined}>
        <View style={styles.syncRow}>
          <AppText
            variant="caption"
            tone="secondary"
            style={styles.syncStatus}
            accessibilityLiveRegion="polite"
          >
            {busy ? "Checking for photos…" : syncProgress(snapshot, now)}
          </AppText>
          <Button
            label="Sync now"
            variant="text"
            loading={busy}
            onPress={() => void reconcile()}
          />
        </View>
        {syncError || failure ? (
          <AppText variant="caption" tone="secondary" accessibilityRole="alert">
            {failure ?? "Couldn’t start sync yet. Try again."}
          </AppText>
        ) : null}
        {photos.length === 0 && galleryFilterCount(filters) > 0 ? (
          <Stack gap="sm" style={{ flex: 1, justifyContent: "center" }}>
            <AppText variant="headline">No photos for these filters</AppText>
            <AppText tone="secondary">Try another person or date.</AppText>
            <Button
              variant="text"
              label="Clear filters"
              onPress={onClearFilters ?? (() => {})}
            />
          </Stack>
        ) : photos.length > 0 ? (
          <TripPhotoGallery photos={photos} />
        ) : (
          <Stack gap="xs" style={{ flex: 1, justifyContent: "center" }}>
            <AppText variant="title2">Your roll starts here.</AppText>
            <AppText tone="secondary">
              New photos from your crew will arrive here automatically.
            </AppText>
          </Stack>
        )}
        {snapshot.paused ? (
          <AppText accessibilityLiveRegion="polite" tone="secondary">
            Photo sharing is paused.
          </AppText>
        ) : null}
        {blocked ? (
          <Stack gap="xs">
            {snapshot.blockers.map((blocker) => (
              <AppText accessibilityRole="alert" key={blocker} tone="critical">
                {blockerCopy[blocker]}
              </AppText>
            ))}
          </Stack>
        ) : null}
        {cursor !== null ? (
          <Button
            label="First photos"
            variant="text"
            onPress={() => setCursor(null)}
          />
        ) : null}
        {state?.assets.nextCursor ? (
          <Button
            label="More photos"
            variant="text"
            onPress={() => setCursor(state.assets.nextCursor)}
          />
        ) : null}
      </Stack>
    </>
  );
}

const styles = StyleSheet.create({
  syncRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  syncStatus: { flex: 1 },
});
