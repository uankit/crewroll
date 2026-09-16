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
      ) : null}
      {error ? (
        <AppText tone="critical">
          The connection setting couldn’t change. Try again.
        </AppText>
      ) : null}
    </Sheet>
  );
}
