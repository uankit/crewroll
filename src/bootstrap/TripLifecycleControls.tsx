import { useEffect, useRef, useState } from "react";
import type { TripLifecycleBody, TripTransferState } from "@crewroll/contracts";
import { AppText, Button, Stack } from "../design-system";
import { useAppSession } from "./AppSessionProvider";

export function TripLifecycleControls({
  tripId,
  owner,
  onChanged,
}: Readonly<{ tripId: string; owner: boolean; onChanged?: () => void }>) {
  const { actions } = useAppSession();
  const [state, setState] = useState<TripTransferState | null>(null);
  const [confirmation, setConfirmation] = useState<
    "LEAVE" | "LEAVE_NOW" | "END" | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const canShare =
    state?.status === "ACTIVE" && state.participation === "JOINED";
  const canExit =
    (state?.status === "ACTIVE" || state?.status === "LOBBY") &&
    state.participation !== "LEAVING" &&
    state.participation !== "LEFT";
  const canLeaveNow =
    state?.participation === "LEAVING" && state.status === "ACTIVE";
  useEffect(() => {
    let cancelled = false;
    let reading = false;
    const read = async () => {
      if (!actions || reading || inFlight.current) return;
      reading = true;
      try {
        const value = await actions.getTripLifecycle(tripId);
        if (!cancelled) {
          setState(value);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Trip controls couldn’t refresh. Try again.");
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [actions, tripId]);
  async function change(action: TripLifecycleBody["action"]) {
    const allowed =
      action === "PAUSE" || action === "RESUME"
        ? canShare
        : action === "LEAVE_NOW"
          ? canLeaveNow
          : canExit;
    if (!actions || inFlight.current || !state || !allowed) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await actions.changeTripLifecycle(tripId, {
        action,
        expectedVersion: state.version,
      });
      setState(result);
      setConfirmation(null);
      onChanged?.();
    } catch {
      setError(
        "The change wasn’t confirmed. Refreshing the trip—please try again.",
      );
      try {
        setState(await actions.getTripLifecycle(tripId));
      } catch {
        /* Leave the last confirmed state visible. */
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
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
          disabled={!canShare || busy}
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
