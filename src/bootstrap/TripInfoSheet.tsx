import { TripContinuityControls } from "./TripContinuityControls";
import { useState } from "react";
import { AccountMenuRow } from "./AccountMenuRow";
import { SafetyActions } from "./SafetyActions";
import { useAccountPrivacy } from "./AccountPrivacy";
import type { TripView } from "../domain/trips/model";
import { AppText, Sheet, Stack } from "../design-system";
import { TripLifecycleControls } from "./TripLifecycleControls";

export function TripInfoSheet({
  trip,
  onDismiss,
  onChanged,
}: Readonly<{ trip: TripView; onDismiss: () => void; onChanged: () => void }>) {
  const privacy = useAccountPrivacy();
  const [selected, setSelected] = useState<string | null>(null);
  const selectedMember = trip.members.find((m) => m.membershipId === selected);
  if (selectedMember)
    return (
      <SafetyActions
        target={{
          tripId: trip.id,
          membershipId: selectedMember.membershipId,
          name: selectedMember.displayName,
          owner: trip.members.some(
            (m) => m.isCurrentMember && m.role === "OWNER",
          ),
        }}
        onDismiss={() => setSelected(null)}
        onChanged={() => {
          setSelected(null);
          onDismiss();
          onChanged();
        }}
      />
    );
  return (
    <Sheet visible title="Trip info" onDismiss={onDismiss}>
      <Stack gap="xs">
        <AppText variant="title2">{trip.name}</AppText>
        {trip.startsAt ? (
          <AppText variant="caption" tone="secondary">
            Started ·{" "}
            {new Date(trip.startsAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </AppText>
        ) : null}
        <AppText variant="caption" tone="secondary">
          Ends ·{" "}
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
          .map((member) =>
            privacy && !member.isCurrentMember ? (
              <AccountMenuRow
                key={member.membershipId}
                label={`${member.displayName}${member.role === "OWNER" ? " · Host" : ""}`}
                onPress={() => setSelected(member.membershipId)}
              />
            ) : (
              <AppText key={member.membershipId}>
                {member.displayName}
                {member.isCurrentMember ? " (you)" : ""}
                {member.role === "OWNER" ? " · Host" : ""}
              </AppText>
            ),
          )}
      </Stack>
      <TripLifecycleControls
        tripId={trip.id}
        owner={trip.members.some(
          (m) => m.isCurrentMember && m.role === "OWNER",
        )}
        onChanged={onChanged}
      />
    </Sheet>
  );
}
