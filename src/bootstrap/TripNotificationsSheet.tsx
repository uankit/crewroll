import { useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { AppIcon, AppText, Sheet, Stack, spacing } from "../design-system";
import { JoinRequestRow } from "../features/trips/JoinRequestRow";
import type { TripView } from "../domain/trips/model";
import { useAppSession } from "./AppSessionProvider";
import { useTripContinuity } from "./useTripContinuity";

export function TripNotificationsSheet({
  trip,
  onDismiss,
  onChanged,
}: Readonly<{
  trip: TripView;
  onDismiss: () => void;
  onChanged: () => void;
}>) {
  const session = useAppSession();
  // The trip route owns the polling timer; this sheet shares its cached result.
  const continuity = useTripContinuity(trip.id, false);
  const [busy, setBusy] = useState<{
    id: string;
    action: "approve" | "decline";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const working = useRef(false);
  const owner = trip.members.some(
    (m) => m.isCurrentMember && m.role === "OWNER",
  );
  const open = trip.status === "ACTIVE";
  const pending =
    owner && open
      ? trip.members.filter(
          (m) =>
            m.status === "PENDING_KEY" && !resolved.includes(m.membershipId),
        )
      : [];
  const phones =
    continuity.data?.approvalRequests.filter(
      (r) => !resolved.includes(r.requestId),
    ) ?? [];
  const count = pending.length + phones.length;

  async function resolve(
    id: string,
    name: string,
    approve: boolean,
    phone = false,
  ) {
    if (working.current || !session.actions) return;
    working.current = true;
    setBusy({ id, action: approve ? "approve" : "decline" });
    setError(null);
    setAnnouncement(null);
    try {
      if (phone) {
        const result = await session.actions.resolveDeviceRecovery(
          trip.id,
          id,
          approve,
        );
        if (!result.onThisDevice) {
          await session.signOut();
          return;
        }
      } else if (approve) {
        await session.actions.approve(trip.id, id);
      } else {
        await session.actions.reject(trip.id, id);
      }
      setResolved((current) => [...current, id]);
      setAnnouncement(approve ? null : `${name}’s request declined.`);
      void continuity.refetch();
      onChanged();
    } catch {
      setError("The request couldn’t be updated. Try again.");
    } finally {
      working.current = false;
      setBusy(null);
    }
  }

  return (
    <Sheet visible title="Notifications" onDismiss={onDismiss}>
      {pending.length > 0 ? (
        <Stack gap="xs">
          <AppText variant="eyebrow" tone="secondary">
            JOIN REQUESTS · {pending.length}
          </AppText>
          {pending.map((member) => (
            <JoinRequestRow
              key={member.membershipId}
              name={member.displayName}
              busy={busy?.id === member.membershipId ? busy.action : null}
              disabled={busy !== null || !session.actions}
              onApprove={() =>
                void resolve(member.membershipId, member.displayName, true)
              }
              onDecline={() =>
                void resolve(member.membershipId, member.displayName, false)
              }
            />
          ))}
        </Stack>
      ) : null}
      {phones.length > 0 ? (
        <Stack gap="xs">
          <AppText variant="eyebrow" tone="secondary">
            CONFIRM A PHONE
          </AppText>
          {phones.map((request) => (
            <Stack gap="xs" key={request.requestId}>
              <JoinRequestRow
                name={request.displayName}
                description={
                  request.platform === "ios"
                    ? "New iPhone"
                    : "New Android phone"
                }
                busy={busy?.id === request.requestId ? busy.action : null}
                disabled={busy !== null || !session.actions}
                onApprove={() =>
                  void resolve(
                    request.requestId,
                    request.displayName,
                    true,
                    true,
                  )
                }
                onDecline={() =>
                  void resolve(
                    request.requestId,
                    request.displayName,
                    false,
                    true,
                  )
                }
              />
              <AppText variant="caption" tone="secondary">
                Confirm this phone with {request.displayName.split(" ")[0]}.
                Approval replaces their previous phone’s access.
              </AppText>
            </Stack>
          ))}
        </Stack>
      ) : null}
      {count === 0 ? (
        <Stack gap="xs" style={styles.empty}>
          <AppIcon name="bell" />
          <AppText variant="bodyStrong">You’re all caught up.</AppText>
          <AppText variant="caption" tone="secondary">
            New requests will appear here.
          </AppText>
        </Stack>
      ) : null}
      {announcement ? (
        <AppText
          variant="caption"
          tone="secondary"
          accessibilityLiveRegion="polite"
        >
          {announcement}
        </AppText>
      ) : null}
      {error ? (
        <AppText variant="caption" tone="critical" accessibilityRole="alert">
          {error}
        </AppText>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: "center", paddingVertical: spacing.xl },
});
