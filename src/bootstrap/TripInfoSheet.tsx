import { TripContinuityControls } from "./TripContinuityControls";
import { useEffect, useState } from "react";
import type { TripView } from "../domain/trips/model";
import { AppText, Button, Sheet, Stack } from "../design-system";
import { crewRollTransfer } from "../infrastructure/native/crewRollTransfer";
import { TripLifecycleControls } from "./TripLifecycleControls";

export function TripInfoSheet({
  trip,
  onDismiss,
  onChanged,
}: Readonly<{ trip: TripView; onDismiss: () => void; onChanged: () => void }>) {
  const [cellular, setCellular] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void crewRollTransfer
      .getSnapshot()
      .then((snapshot) => {
        if (!cancelled && snapshot.activeTripId === trip.id)
          setCellular(snapshot.cellularAllowed ?? false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [trip.id]);
  return (
    <Sheet visible title="Trip info" onDismiss={onDismiss}>
      <Stack gap="xs">
        <AppText variant="title2">{trip.name}</AppText>
        <AppText variant="label" tone="secondary">
          Scheduled end ·{" "}
          {new Date(trip.endsAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </AppText>
      </Stack>
      <TripContinuityControls trip={trip} onChanged={onChanged} />
      <Stack gap="sm">
        <AppText variant="eyebrow" tone="secondary">
          YOUR CREW
        </AppText>
        {trip.members
          .filter((m) => m.status === "ACTIVE")
          .map((member) => (
            <AppText key={member.membershipId}>
              {member.isCurrentMember ? "You" : member.displayName}
              {member.role === "OWNER" ? " · Host" : ""}
            </AppText>
          ))}
      </Stack>
      <TripLifecycleControls
        tripId={trip.id}
        owner={trip.members.some(
          (m) => m.isCurrentMember && m.role === "OWNER",
        )}
        onChanged={onChanged}
      />
      {cellular !== null ? (
        <Stack gap="xs">
          <Button
            label="Sync now"
            variant="secondary"
            loading={busy}
            onPress={() => {
              if (busy) return;
              setBusy(true);
              setError(false);
              void crewRollTransfer
                .reconcileNow({ protocolVersion: 1 })
                .catch(() => setError(true))
                .finally(() => setBusy(false));
            }}
          />
          <AppText variant="caption" tone="secondary">
            Sync continues in the background when your phone allows it. Opening
            CrewRoll helps finish any waiting photos.
          </AppText>
          <Button
            label={cellular ? "Use Wi-Fi only" : "Allow mobile data"}
            variant="text"
            loading={busy}
            onPress={() => {
              if (busy) return;
              setBusy(true);
              setError(false);
              void crewRollTransfer
                .getSnapshot()
                .then(async (snapshot) => {
                  if (snapshot.activeTripId !== trip.id) return;
                  await crewRollTransfer.setTransferPolicy({
                    protocolVersion: 1,
                    paused: snapshot.paused,
                    cellularAllowed: !cellular,
                  });
                  setCellular(!cellular);
                })
                .catch(() => setError(true))
                .finally(() => setBusy(false));
            }}
          />
        </Stack>
      ) : null}
      {error ? (
        <AppText tone="critical">
          Sync couldn’t update. Check your connection and try again.
        </AppText>
      ) : null}
    </Sheet>
  );
}
