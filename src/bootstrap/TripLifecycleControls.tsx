import { useEffect, useRef, useState } from "react";
import type { TripLifecycleBody, TripTransferState } from "@crewroll/contracts";
import { AppText, Button, Stack } from "../design-system";
import { useAppSession } from "./AppSessionProvider";

export function TripLifecycleControls({
  tripId,
  owner,
  onChanged,
}: Readonly<{ tripId: string; owner: boolean; onChanged?: () => void }>) {
  const { queryScope } = useAppSession();
  return (
    <TripLifecycleContent
      key={JSON.stringify([
        queryScope?.opaqueAccountScope,
        queryScope?.deviceId,
        tripId,
      ])}
      tripId={tripId}
      owner={owner}
      {...(onChanged ? { onChanged } : {})}
    />
  );
}

function TripLifecycleContent({
  tripId,
  owner,
  onChanged,
}: Readonly<{ tripId: string; owner: boolean; onChanged?: () => void }>) {
  const { actions, capabilities } = useAppSession();
  const [observed, setState] = useState<TripTransferState | null>(null);
  const state = observed?.tripId === tripId ? observed : null;
  const [confirmation, setConfirmation] = useState<
    "LEAVE" | "LEAVE_NOW" | "END" | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const canPause =
    capabilities.canMutateTrip &&
    state?.status === "ACTIVE" &&
    state.participation === "JOINED";
  const canResume = canPause && capabilities.canSharePhotos;
  const canExit =
    capabilities.canMutateTrip &&
    (state?.status === "ACTIVE" || state?.status === "LOBBY") &&
    state.participation !== "LEAVING" &&
    state.participation !== "LEFT";
  const canLeaveNow =
    capabilities.canMutateTrip &&
    state?.participation === "LEAVING" &&
    state.status === "ACTIVE";
  useEffect(() => {
    const epoch = ++generation.current;
    let cancelled = false;
    let reading = false;
    inFlight.current = false;
    if (!actions || !capabilities.canReadLibrary) return;
    let firstRead = true;
    const read = async () => {
      if (!actions || reading || inFlight.current) return;
      reading = true;
      try {
        const value = await actions.getTripLifecycle(tripId);
        if (!cancelled && epoch === generation.current) {
          setState(value);
          setError(null);
        }
      } catch {
        if (!cancelled && epoch === generation.current)
          setError("Trip controls couldn’t refresh. Try again.");
      } finally {
        reading = false;
        if (!cancelled && epoch === generation.current && firstRead) {
          firstRead = false;
          setBusy(false);
          setConfirmation(null);
        }
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      cancelled = true;
      generation.current = epoch + 1;
      clearInterval(timer);
    };
  }, [actions, capabilities.canReadLibrary, tripId]);
  async function change(action: TripLifecycleBody["action"]) {
    const allowed =
      action === "PAUSE"
        ? canPause
        : action === "RESUME"
          ? canResume
          : action === "LEAVE_NOW"
            ? canLeaveNow
            : canExit;
    if (!actions || inFlight.current || !state || !allowed) return;
    inFlight.current = true;
    const epoch = generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await actions.changeTripLifecycle(tripId, {
        action,
        expectedVersion: state.version,
      });
      if (epoch !== generation.current) return;
      setState(result);
      setConfirmation(null);
      onChanged?.();
    } catch {
      if (epoch !== generation.current) return;
      setError(
        "The change wasn’t confirmed. Refreshing the trip—please try again.",
      );
      try {
        const refreshed = await actions.getTripLifecycle(tripId);
        if (epoch === generation.current) setState(refreshed);
      } catch {
        /* Leave the last confirmed state visible. */
      }
    } finally {
      if (epoch === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  if (confirmation && (confirmation === "LEAVE_NOW" ? canLeaveNow : canExit))
    return (
      <Stack gap="md" testID="trip-exit-confirmation">
        <AppText variant="title2">
          {confirmation === "END"
            ? "End this trip?"
            : confirmation === "LEAVE_NOW"
              ? "Leave without finishing?"
              : "Leave this trip?"}
        </AppText>
        <AppText tone="secondary">
          {confirmation === "END"
            ? "New photo sharing stops for everyone. Queued photos will keep syncing. Each person can start another trip once their sync finishes."
            : confirmation === "LEAVE_NOW"
              ? "Unfinished uploads may not reach your crew, and photos you haven’t saved may be missed. Photos already saved on your phone stay there."
              : "We’ll stop sharing new photos, finish your uploads and save the photos already queued for you. Then you’ll leave automatically."}
        </AppText>
        <AppText variant="caption" tone="secondary">
          Photos already shared stay with your crew. Leaving doesn’t remove
          anyone’s saved copies.
        </AppText>
        <Button
          label={
            confirmation === "END"
              ? "End trip"
              : confirmation === "LEAVE_NOW"
                ? "Leave now"
                : "Finish syncing and leave"
          }
          loading={busy}
          onPress={() => void change(confirmation)}
        />
        <Button
          label={confirmation === "LEAVE_NOW" ? "Keep syncing" : "Stay in trip"}
          variant="text"
          disabled={busy}
          onPress={() => setConfirmation(null)}
        />
        {error ? (
          <AppText accessibilityRole="alert" tone="critical">
            {error}
          </AppText>
        ) : null}
      </Stack>
    );
  return (
    <Stack gap="sm" testID="trip-lifecycle-controls">
      {state && state.status !== "LOBBY" ? (
        <Button
          variant="secondary"
          label={state.sharingPaused ? "Resume my sharing" : "Pause my sharing"}
          disabled={!(state.sharingPaused ? canResume : canPause) || busy}
          loading={busy}
          onPress={() => void change(state.sharingPaused ? "RESUME" : "PAUSE")}
        />
      ) : null}
      <Button
        label={owner ? "End trip" : "Leave trip"}
        variant="text"
        disabled={!canExit || busy}
        onPress={() => setConfirmation(owner ? "END" : "LEAVE")}
      />
      {canLeaveNow && state ? (
        <>
          <AppText variant="caption" tone="secondary">
            {state.pendingDownloads || state.pendingUploads
              ? `Finishing sync · ${state.pendingDownloads} to save · ${state.pendingUploads} arriving`
              : "Finishing sync before you leave."}
          </AppText>
          <Button
            label="Leave now"
            variant="text"
            disabled={busy}
            onPress={() => setConfirmation("LEAVE_NOW")}
          />
        </>
      ) : state?.participation === "LEFT" ? (
        <AppText variant="caption" tone="secondary">
          You’ve left this trip.
        </AppText>
      ) : null}
      {!state && !error ? (
        <AppText tone="secondary">Loading trip controls…</AppText>
      ) : null}
      {error ? (
        <AppText accessibilityRole="alert" tone="critical">
          {error}
        </AppText>
      ) : null}
    </Stack>
  );
}
