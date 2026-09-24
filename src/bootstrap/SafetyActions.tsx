import { useRef, useState } from "react";
import type { SafetyReportBody } from "@crewroll/contracts";
import { AppText, Button, Sheet, Stack, TextField } from "../design-system";
import { AccountMenuRow } from "./AccountMenuRow";
import { useAccountPrivacy } from "./AccountPrivacy";
import { useAppSession } from "./AppSessionProvider";
import { crewRollTransfer } from "../infrastructure/native/crewRollTransfer";

type Target = {
  tripId: string;
  membershipId?: string;
  assetId?: string;
  name?: string;
  owner?: boolean;
};
const reasons = [
  ["INAPPROPRIATE", "Inappropriate content"],
  ["HARASSMENT", "Harassment or threats"],
  ["PRIVACY", "Privacy or consent"],
  ["OTHER", "Something else"],
] as const;
export function SafetyActions({
  target,
  onDismiss,
  onChanged,
}: Readonly<{ target: Target; onDismiss(): void; onChanged?(): void }>) {
  const privacy = useAccountPrivacy();
  const session = useAppSession();
  const [page, setPage] = useState<"menu" | "report" | "block" | "sent">(
    target.assetId ? "report" : "menu",
  );
  const [reason, setReason] = useState<SafetyReportBody["reason"] | null>(null);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);
  const send = async () => {
    if (!privacy || running.current) return;
    running.current = true;
    setBusy(true);
    setFailed(false);
    try {
      if (page === "block" && target.membershipId) {
        await privacy.api.blockMember({
          tripId: target.tripId,
          membershipId: target.membershipId,
        });
        await crewRollTransfer.deactivateTrip({
          protocolVersion: 1,
          tripId: target.tripId,
        });
        onChanged?.();
        onDismiss();
        session.retry();
      } else if (reason) {
        await privacy.api.reportSafetyIssue({
          tripId: target.tripId,
          ...(target.assetId
            ? { assetId: target.assetId }
            : { membershipId: target.membershipId! }),
          reason,
          ...(details.trim() ? { details: details.trim() } : {}),
        });
        setPage("sent");
      }
    } catch {
      setFailed(true);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <Sheet
      visible
      title={
        page === "menu"
          ? (target.name ?? "Member")
          : page === "block"
            ? "Block this person?"
            : page === "sent"
              ? "Report received"
              : target.assetId
                ? "Report photo"
                : "Report member"
      }
      onDismiss={() => {
        if (!running.current) onDismiss();
      }}
    >
      {page === "menu" ? (
        <Stack gap="none">
          <AccountMenuRow
            label="Report member"
            onPress={() => setPage("report")}
          />
          <AccountMenuRow
            label="Block member"
            critical
            onPress={() => setPage("block")}
          />
        </Stack>
      ) : null}
      {page === "report" ? (
        <Stack gap="sm">
          <AppText tone="secondary">
            What’s wrong? Reports go to CrewRoll support.
          </AppText>
          {reasons.map(([value, label]) => (
            <Button
              key={value}
              label={label}
              variant={reason === value ? "primary" : "secondary"}
              disabled={busy}
              onPress={() => setReason(value)}
            />
          ))}
          <TextField
            label="Details (optional)"
            value={details}
            onChangeText={setDetails}
            maxLength={1000}
            multiline
            disabled={busy}
            placeholder="Tell us what happened"
          />
          <AppText variant="caption" tone="secondary">
            Photos stay private. Please describe the concern so we can review
            it.
          </AppText>
          <Button
            label="Send report"
            disabled={!reason}
            loading={busy}
            onPress={() => void send()}
          />
        </Stack>
      ) : null}
      {page === "block" ? (
        <Stack gap="md">
          <AppText>
            {target.owner
              ? "This ends the trip for everyone and stops sharing immediately."
              : "This leaves the trip and stops sharing immediately."}{" "}
            You won’t be able to join a trip together while they’re blocked.
          </AppText>
          <AppText tone="secondary">
            Photos already saved stay on each person’s phone.
          </AppText>
          <Button
            label={target.owner ? "Block & end trip" : "Block & leave trip"}
            variant="critical"
            loading={busy}
            onPress={() => void send()}
          />
          <Button
            label="Cancel"
            variant="text"
            disabled={busy}
            onPress={onDismiss}
          />
        </Stack>
      ) : null}
      {page === "sent" ? (
        <Stack gap="md">
          <AppText>
            Thank you. We’ll review your report. You can also block this person
            from Trip info.
          </AppText>
          <Button label="Done" onPress={onDismiss} />
        </Stack>
      ) : null}
      {failed ? (
        <AppText tone="critical" accessibilityRole="alert">
          Couldn’t confirm the change. Please try again.
        </AppText>
      ) : null}
    </Sheet>
  );
}
