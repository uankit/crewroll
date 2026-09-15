import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import type {
  AssetPage,
  DurableEngineSnapshot,
} from "@crewroll/contracts/native/protocol";

import {
  AppText,
  Button,
  InlineBanner,
  Stack,
  TransferHealthCard,
  TripPhotoGallery,
} from "../design-system";
import { crewRollTransfer } from "../infrastructure/native/crewRollTransfer";

import { createObservedRead } from "./observedRead";

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
export function ActiveTripTransfers({ tripId }: Readonly<{ tripId: string }>) {
  const [state, setState] = useState<Readonly<{
    snapshot: DurableEngineSnapshot;
    assets: AssetPage;
  }> | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);

  useEffect(() => {
    const reader = createObservedRead({
      active: () => AppState.currentState !== "background",
      read: async () => {
        const snapshot = await crewRollTransfer.getSnapshot();
        const assets = await crewRollTransfer.listAssets({
          protocolVersion: 1,
          cursor,
          limit: 24,
        });
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
  }, [tripId, refreshKey, cursor]);

  const reconcile = useCallback(
    async (workId?: string) => {
      if (busy) return;
      setBusy(true);
      try {
        if (workId)
          await crewRollTransfer.retry({ protocolVersion: 1, workId });
        else await crewRollTransfer.reconcileNow({ protocolVersion: 1 });
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
        setRefreshKey((value) => value + 1);
      }
    },
    [busy],
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
  if (failed || snapshot === null)
    return (
      <Stack gap="sm">
        <InlineBanner
          title={
            failed
              ? "Photo delivery needs attention"
              : "Checking photo delivery"
          }
          body={
            failed
              ? "This phone's transfer status is unavailable. No delivery is being claimed as complete."
              : "Reading this phone's saved-photo and transfer progress."
          }
          icon={failed ? "!" : "…"}
          tone={failed ? "warning" : "info"}
        />
        {failed ? (
          <Button
            label="Refresh photo status"
            onPress={() => setRefreshKey((value) => value + 1)}
          />
        ) : null}
      </Stack>
    );
  const { discovered, originalsSaved, previewReady } = snapshot.counts;
  const connection = snapshot.cellularAllowed
    ? "Wi-Fi or mobile data"
    : "Wi-Fi";
  const blocked = snapshot.blockers.length > 0;
  return (
    <Stack gap="sm">
      <TransferHealthCard
        title="Trip photos"
        testID="active-photo-progress"
        status={{
          icon: blocked ? "!" : "…",
          label: blocked
            ? "Needs attention"
            : snapshot.paused
              ? "Paused"
              : "Sharing active",
          tone: blocked ? "warning" : "info",
        }}
        summary={
          discovered === 0
            ? `Take a photo with your phone's Camera during the trip. Use ${connection} and keep CrewRoll open to sync; reopen it after taking photos.`
            : `${previewReady} previews ready · ${originalsSaved} of ${discovered} originals saved on this phone. Keep CrewRoll open on ${connection} to finish sharing.`
        }
        progress={{
          label: `${originalsSaved} of ${discovered} saved on this phone`,
          value: discovered === 0 ? 0 : originalsSaved / discovered,
        }}
        action={{
          label: busy ? "Checking photos…" : "Check for photos now",
          disabled: busy || snapshot.paused,
          onPress: () => void reconcile(),
        }}
      />
      {photos.length > 0 ? <TripPhotoGallery photos={photos} /> : null}
      <AppText tone="secondary" variant="caption">
        Take photos with Camera, then return here. Previews arrive first;
        full-quality photos save automatically. Each phone shows its own
        progress.
      </AppText>
      {snapshot.cellularAllowed !== undefined ? (
        <Button
          label={
            snapshot.cellularAllowed
              ? "Use Wi-Fi only"
              : "Allow mobile data (uses your data plan)"
          }
          variant="secondary"
          disabled={busy || snapshot.paused}
          onPress={() => {
            setBusy(true);
            void crewRollTransfer
              .setTransferPolicy({
                protocolVersion: 1,
                paused: snapshot.paused,
                cellularAllowed: !snapshot.cellularAllowed,
              })
              .catch(() => setFailed(true))
              .finally(() => {
                setBusy(false);
                setRefreshKey((value) => value + 1);
              });
          }}
        />
      ) : null}
      {cursor !== null ? (
        <Button
          label="Latest photos"
          variant="secondary"
          onPress={() => setCursor(null)}
        />
      ) : null}
      {state?.assets.nextCursor ? (
        <Button
          label="Older photos"
          variant="secondary"
          onPress={() => setCursor(state.assets.nextCursor)}
        />
      ) : null}
      {snapshot.blockers.map((blocker) => (
        <AppText key={blocker} tone="secondary">
          {blockerCopy[blocker]}
        </AppText>
      ))}
      {state?.assets.items
        .filter((asset) => asset.blocker !== null)
        .slice(0, 10)
        .map((asset, index) => (
          <Button
            key={asset.workId}
            label={`Retry blocked photo ${index + 1}`}
            variant="secondary"
            disabled={busy}
            onPress={() => void reconcile(asset.workId)}
          />
        ))}
    </Stack>
  );
}
