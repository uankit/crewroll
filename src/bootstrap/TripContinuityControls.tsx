import { useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import {
  AppText,
  Button,
  InviteCard,
  MemberAvatar,
  Stack,
} from "../design-system";
import type { TripView } from "../domain/trips/model";
import { useAppSession } from "./AppSessionProvider";
import { useTripContinuity } from "./useTripContinuity";

export function TripContinuityControls({
  trip,
  onChanged,
}: Readonly<{ trip: TripView; onChanged: () => void }>) {
  const session = useAppSession();
  // The trip route owns polling. The sheet observes the same cache and only
  // explicitly refetches after a command, without a second polling timer.
  const continuity = useTripContinuity(trip.id, false);
  const [invite, setInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const owner = trip.members.some(
    (m) => m.isCurrentMember && m.role === "OWNER",
  );
  const open = trip.status === "ACTIVE" || trip.status === "LOBBY";
  async function perform(id: string, action: () => Promise<unknown>) {
    if (working.current) return;
    working.current = true;
    setBusy(id);
    setError(null);
    try {
      const refresh = await action();
      if (refresh === false) return;
      await continuity.refetch();
      onChanged();
    } catch {
      setError(
        "The change wasn’t confirmed. Check your connection and try again.",
      );
    } finally {
      working.current = false;
      setBusy(null);
    }
  }
  const code =
    continuity.data?.ownerInviteCode ?? invite ?? session.ownerInviteCode;
  return (
    <Stack gap="md">
      {continuity.data?.syncFrom && trip.status === "ACTIVE" ? (
        <AppText variant="caption" tone="secondary">
          Sharing since{" "}
          {new Date(continuity.data.syncFrom).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </AppText>
      ) : null}
      {owner && open && code ? (
        <InviteCard
          code={code}
          onCopy={async () => {
            if (!(await Clipboard.setStringAsync(code)))
              throw new Error("Clipboard unavailable");
          }}
        />
      ) : null}
      {owner && open && !code ? (
        <Button
          variant="text"
          label="Load invite code"
          loading={busy === "invite"}
          onPress={() =>
            void perform("invite", async () => {
              const result = await session.actions?.ensureOwnerInvite(trip.id);
              setInvite(result?.ownerInviteCode ?? null);
            })
          }
        />
      ) : null}
      {owner && open
        ? trip.members
            .filter((m) => m.status === "PENDING_KEY")
            .map((member) => (
              <Stack key={member.membershipId} gap="xs">
                <AppText variant="eyebrow" tone="secondary">
                  JOIN REQUEST
                </AppText>
                <MemberAvatar displayName={member.displayName} />
                <AppText variant="bodyStrong">{member.displayName}</AppText>
                <Button
                  label={`Approve ${member.displayName.split(" ")[0]}`}
                  loading={busy === member.membershipId}
                  disabled={!!busy && busy !== member.membershipId}
                  onPress={() =>
                    void perform(member.membershipId, () =>
                      session.actions!.approve(trip.id, member.membershipId),
                    )
                  }
                />
                <AppText variant="caption" tone="secondary">
                  Photos start sharing from approval onward. Earlier photos stay
                  private.
                </AppText>
              </Stack>
            ))
        : null}
      {continuity.data?.approvalRequests.map((request) => (
        <Stack key={request.requestId} gap="xs">
          <AppText variant="eyebrow" tone="secondary">
            CONFIRM A PHONE
          </AppText>
          <AppText variant="bodyStrong">
            {request.displayName} ·{" "}
            {request.platform === "ios" ? "iPhone" : "Android"}
          </AppText>
          <AppText tone="secondary">
            Confirm with {request.displayName.split(" ")[0]} that this is their
            phone. Approval replaces their previous phone’s access.
          </AppText>
          <Button
            label="Approve this phone"
            loading={busy === request.requestId}
            disabled={!!busy && busy !== request.requestId}
            onPress={() =>
              void perform(request.requestId, async () => {
                const result = await session.actions!.resolveDeviceRecovery(
                  trip.id,
                  request.requestId,
                  true,
                );
                if (!result.onThisDevice) {
                  // Approval explicitly transfers this phone's access. End its
                  // foreground session too, before another authenticated read.
                  await session.signOut();
                  return false;
                }
              })
            }
          />
          <Button
            label="Not their phone"
            variant="text"
            disabled={!!busy}
            onPress={() =>
              void perform(request.requestId, () =>
                session.actions!.resolveDeviceRecovery(
                  trip.id,
                  request.requestId,
                  false,
                ),
              )
            }
          />
        </Stack>
      ))}
      {error ? (
        <AppText tone="critical" accessibilityRole="alert">
          {error}
        </AppText>
      ) : null}
    </Stack>
  );
}
