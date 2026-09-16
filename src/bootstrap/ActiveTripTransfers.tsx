import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import type {
  AssetPage,
  DurableEngineSnapshot,
} from "@crewroll/contracts/native/protocol";

import {
  AppText,
  BrandLoading,
  Button,
  Sheet,
  Stack,
  TripPhotoGallery,
} from "../design-system";
import { crewRollTransfer } from "../infrastructure/native/crewRollTransfer";
import {
  defaultGalleryFilters,
  galleryFilterCount,
  galleryQuery,
  type GalleryFilters,
} from "../domain/trips/galleryFilters";

import { createObservedRead } from "./observedRead";
import type { TripView } from "../domain/trips/model";

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

/** Read-only native projections. Photo bytes and decryption keys never enter JS. */
export function ActiveTripTransfers({
  tripId,
  onPhotoCountChange,
  filters = defaultGalleryFilters,
  onClearFilters,
  tripInfo,
  infoOpen = false,
  onCloseInfo,
}: Readonly<{
  tripId: string;
  onPhotoCountChange?: (count: number) => void;
  filters?: GalleryFilters;
  onClearFilters?: () => void;
  tripInfo?: TripView;
  infoOpen?: boolean;
  onCloseInfo?: () => void;
}>) {
  const [state, setState] = useState<Readonly<{
    snapshot: DurableEngineSnapshot;
    assets: AssetPage;
  }> | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [policyFailed, setPolicyFailed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const query = useMemo(() => galleryQuery(filters), [filters]);

  useEffect(() => {
    const reader = createObservedRead({
      active: () => AppState.currentState !== "background",
      read: async () => {
        const [snapshot, assets] = await Promise.all([
          crewRollTransfer.getSnapshot(),
          crewRollTransfer.listAssets({
            protocolVersion: 1,
            cursor,
            limit: 24,
            ...query,
          }),
        ]);
        return { snapshot, assets };
      },
      ready: ({ snapshot, assets }) => {
        // Never show a prior account/trip's native projection during transitions.
        if (
          snapshot.activeTripId !== tripId ||
          (assets.activeTripId !== undefined &&
            assets.activeTripId !== tripId) ||
          (assets.items.some((asset) => asset.previewUri) &&
            assets.activeTripId !== tripId)
        ) {
          setState(null);
          setFailed(true);
          return;
        }
        setState((previous) =>
          previous?.snapshot.revision === snapshot.revision &&
          previous.assets.revision === assets.revision &&
          previous.assets.items[0]?.assetId === assets.items[0]?.assetId &&
          previous.snapshot.paused === snapshot.paused &&
          previous.snapshot.cellularAllowed === snapshot.cellularAllowed &&
          previous.snapshot.activeTripId === snapshot.activeTripId &&
          previous.snapshot.blockers.join() === snapshot.blockers.join()
            ? previous
            : { snapshot, assets },
        );
        setFailed(false);
      },
      failed: () => {
        if (cursor !== null) setCursor(null);
        else setFailed(true);
      },
    });
    const refresh = reader.refresh;
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    let subscription:
      ReturnType<typeof crewRollTransfer.subscribeToInvalidations> | undefined;
    try {
      subscription = crewRollTransfer.subscribeToInvalidations(
        () => void refresh(),
      );
    } catch {
      // getSnapshot reports the missing-native-module failure in this panel.
      // An unavailable event bridge must not crash the whole trip route.
    }
    const foreground = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh();
    });
    return () => {
      reader.dispose();
      clearInterval(timer);
      subscription?.remove();
      foreground.remove();
    };
  }, [tripId, refreshKey, cursor, query]);

  const reconcile = useCallback(
    async (workId?: string) => {
      if (busy) return;
      setBusy(true);
      try {
        if (workId)
          await crewRollTransfer.retry({ protocolVersion: 1, workId });
        else {
          const blockedIds =
            state?.assets.items
              .filter((asset) => asset.blocker)
              .map((asset) => asset.workId) ?? [];
          for (const id of blockedIds)
            await crewRollTransfer.retry({ protocolVersion: 1, workId: id });
          await crewRollTransfer.reconcileNow({ protocolVersion: 1 });
        }
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
        setRefreshKey((value) => value + 1);
      }
    },
    [busy, state],
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
  const infoSheet =
    tripInfo && infoOpen ? (
      <Sheet
        visible
        title="Trip info"
        showCloseButton={false}
        onDismiss={onCloseInfo ?? (() => {})}
      >
        <Stack gap="xs">
          <AppText variant="title2">{tripInfo.name}</AppText>
          <AppText variant="label" tone="secondary">
            Sharing until{" "}
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(tripInfo.endsAt))}
          </AppText>
        </Stack>
        <Stack gap="sm">
          <AppText variant="label" tone="secondary">
            Crew ·{" "}
            {tripInfo.members.filter((m) => m.status === "ACTIVE").length}{" "}
            people
          </AppText>
          {tripInfo.members
            .filter((m) => m.status === "ACTIVE")
            .map((member) => (
              <AppText key={member.membershipId}>
                {member.isCurrentMember ? "You" : member.displayName}
                {member.role === "OWNER" ? " · Host" : ""}
              </AppText>
            ))}
        </Stack>
        {snapshot?.cellularAllowed !== undefined ? (
          <AppText variant="label" tone="secondary">
            {snapshot.cellularAllowed
              ? "Sharing over Wi-Fi or mobile data"
              : "Sharing over Wi-Fi"}
          </AppText>
        ) : null}
        <AppText variant="label" tone="secondary">
          Take photos with your phone’s camera, then return here to finish
          syncing.
        </AppText>
        {snapshot?.cellularAllowed !== undefined ? (
          <Button
            variant="text"
            label={
              snapshot.cellularAllowed ? "Use Wi-Fi only" : "Allow mobile data"
            }
            accessibilityHint="Mobile data uses your data plan."
            loading={busy}
            disabled={snapshot.paused}
            onPress={() => {
              if (busy) return;
              setBusy(true);
              setPolicyFailed(false);
              void crewRollTransfer
                .setTransferPolicy({
                  protocolVersion: 1,
                  paused: snapshot.paused,
                  cellularAllowed: !snapshot.cellularAllowed,
                })
                .catch(() => setPolicyFailed(true))
                .finally(() => {
                  setBusy(false);
                  setRefreshKey((value) => value + 1);
                });
            }}
          />
        ) : null}
        {policyFailed ? (
          <AppText accessibilityRole="alert" tone="critical">
            The connection setting couldn’t change. Try again.
          </AppText>
        ) : null}
      </Sheet>
    ) : null;
  if (failed || snapshot === null)
    return (
      <>
        <Stack gap="sm" style={{ flex: 1 }}>
          {!failed ? <BrandLoading /> : null}
          {failed ? (
            <AppText accessibilityRole="alert" tone="critical">
              Photos couldn’t refresh. Check your connection and try again.
            </AppText>
          ) : null}
          {failed ? (
            <Button
              label="Try again"
              onPress={() => setRefreshKey((value) => value + 1)}
            />
          ) : null}
        </Stack>
        {infoSheet}
      </>
    );
  const blocked = snapshot.blockers.length > 0;
  return (
    <>
      <Stack gap="sm" style={photos.length === 0 ? { flex: 1 } : undefined}>
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
        ) : null}
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
            <Button
              label="Retry photo sharing"
              loading={busy}
              onPress={() => void reconcile()}
            />
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
      {infoSheet}
    </>
  );
}
