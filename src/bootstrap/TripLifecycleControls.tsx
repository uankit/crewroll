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
    if (!actions || inFlight.current || !state) return;
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
  if (confirmation)
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
      {state?.participation === "LEAVING" ? (
        <>
          <AppText variant="headline">Finishing sync before you leave</AppText>
          <AppText tone="secondary">
            {state.pendingDownloads} photos to save · {state.pendingUploads}{" "}
            uploads still arriving
          </AppText>
          <AppText variant="caption" tone="secondary">
            Keep CrewRoll open to finish. You can come back later; your progress
            is saved. No new photos from your camera will be shared.
          </AppText>
          {state.status === "ENDING" ? (
            <AppText variant="caption" tone="secondary">
              Waiting for the crew’s final photos. Offline phones need to
              reconnect before{" "}
              {new Date(state.deliveryDeadline).toLocaleDateString()}.
            </AppText>
          ) : null}
          <Button
            label="Leave now instead"
            variant="text"
            onPress={() => setConfirmation("LEAVE_NOW")}
          />
        </>
      ) : state?.participation === "LEFT" ? (
        <AppText tone="secondary">You’ve left this trip.</AppText>
      ) : (
        <>
          {state?.status === "ACTIVE" ? (
            <>
              <Button
                variant="secondary"
                label={
                  state.sharingPaused ? "Resume my sharing" : "Pause my sharing"
                }
                loading={busy}
                onPress={() =>
                  void change(state.sharingPaused ? "RESUME" : "PAUSE")
                }
              />
              <AppText variant="caption" tone="secondary">
                {state.sharingPaused
                  ? "Photos taken while paused stay private. You’ll still receive your crew’s photos."
                  : "Pause only your new photos. Uploads and downloads already queued keep going."}
              </AppText>
            </>
          ) : null}
          {!owner ? (
            <Button
              label="Leave trip"
              variant="text"
              disabled={!state || busy}
              onPress={() => setConfirmation("LEAVE")}
            />
          ) : null}
          {owner ? (
            <Button
              label="End trip for everyone"
              variant="text"
              disabled={!state || busy}
              onPress={() => setConfirmation("END")}
            />
          ) : null}
        </>
      )}
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
