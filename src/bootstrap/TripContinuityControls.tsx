import { useRef, useState } from "react";
import { copyInviteCode } from "./copyInviteCode";
import { AppText, Button, InviteCard, Stack } from "../design-system";
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
      {owner && open && code ? (
        <InviteCard code={code} onCopy={() => copyInviteCode(code)} />
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
      {error ? (
        <AppText tone="critical" accessibilityRole="alert">
          {error}
        </AppText>
      ) : null}
    </Stack>
  );
}
