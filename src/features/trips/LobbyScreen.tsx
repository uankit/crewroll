import type { StartBlocker, TripView } from "../../domain/trips/model";
import { startBlockerFor } from "../../domain/trips/startEligibility";
import {
  AppText,
  BlockingCallout,
  Button,
  InlineBanner,
  InviteCard,
  MemberReadinessRow,
  Screen,
  Stack,
  StatusBadge,
  Surface,
  TripSummaryCard,
  type FeedbackStatus,
} from "../../design-system";

export type LobbyInvite = Readonly<{
  code: string;
  url: string;
  onOpenLink: () => void;
  onShare: () => void;
}>;

export type LobbyActivationState =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "working" }>
  | Readonly<{
      kind: "failed";
      onRetry: () => void;
      retrying?: boolean;
    }>;

export type LobbyScreenProps = Readonly<{
  trip: TripView;
  endsLabel: string;
  invite?: LobbyInvite;
  onApproveMember?: (membershipId: string) => void;
  approvingMembershipId?: string;
  onStart?: () => void;
  starting?: boolean;
  activation?: LobbyActivationState;
}>;

function tripStatus(trip: TripView): FeedbackStatus {
  switch (trip.status) {
    case "LOBBY":
      return { icon: "…", label: "Lobby", tone: "info" };
    case "ACTIVE":
      return { icon: "✓", label: "Started", tone: "success" };
    case "ENDING":
      return { icon: "…", label: "Ending", tone: "warning" };
    case "COMPLETE":
      return { icon: "✓", label: "Complete", tone: "success" };
    case "INCOMPLETE_EXPIRED":
      return { icon: "!", label: "Needs attention", tone: "warning" };
    case "CANCELLED":
      return { icon: "×", label: "Cancelled", tone: "neutral" };
  }
}

function memberReadiness(member: TripView["members"][number]): Readonly<{
  status: FeedbackStatus;
  supportingText: string;
}> {
  if (member.status === "PENDING_KEY") {
    return {
      status: {
        icon: "…",
        label: "Waiting for approval",
        tone: "warning",
      },
      supportingText: "Waiting for secure access from the trip owner.",
    };
  }

  if (!member.fullPhotoLibraryAccess) {
    return {
      status: {
        icon: "!",
        label: "Needs full photo access",
        tone: "warning",
      },
      supportingText: "Full photo library access is required.",
    };
  }

  if (member.deviceState === "MISSING") {
    return {
      status: {
        icon: "!",
        label: "Secure access needed",
        tone: "warning",
      },
      supportingText: "Secure access for this phone is not ready.",
    };
  }

  if (member.deviceState === "NOT_DISCLOSED") {
    return {
      status: { icon: "✓", label: "Ready", tone: "success" },
      supportingText: "Secure device details are private.",
    };
  }

  return {
    status: { icon: "✓", label: "Ready", tone: "success" },
    supportingText: "Full photo access",
  };
}

function startBlockerCopy(blocker: StartBlocker): string {
  switch (blocker) {
    case "OWNER_ONLY":
      return "Only the trip owner can start this trip.";
    case "NOT_LOBBY":
      return "This trip cannot be started from its current state.";
    case "MEMBER_PENDING_KEY":
      return "Approve every waiting member before starting.";
    case "MEMBER_NEEDS_FULL_ACCESS":
      return "Everyone needs full photo access before the trip can start.";
    case "MEMBER_DEVICE_MISSING":
      return "A member is still waiting for secure access.";
  }
}

function ActiveTripStatus({
  activation,
}: {
  readonly activation: LobbyActivationState | undefined;
}) {
  if (activation?.kind === "failed") {
    return (
      <Stack gap="sm">
        <BlockingCallout
          body="CrewRoll could not activate automatic photo delivery on this phone. Try again."
          icon="!"
          title="Trip started, but this phone needs attention"
        />
        <Button
          accessibilityHint="Retries secure trip activation on this phone."
          label="Try activation again"
          loading={activation.retrying ?? false}
          onPress={activation.onRetry}
        />
      </Stack>
    );
  }

  if (activation?.kind === "working") {
    return (
      <Surface
        accessibilityLabel="Activating automatic photo delivery on this phone"
        accessibilityRole="summary"
        accessibilityState={{ busy: true }}
        accessible
      >
        <Stack
          accessibilityElementsHidden
          gap="xs"
          importantForAccessibility="no-hide-descendants"
        >
          <StatusBadge icon="…" label="Activating this phone" tone="info" />
          <AppText tone="secondary">
            CrewRoll is securely preparing automatic photo delivery.
          </AppText>
        </Stack>
      </Surface>
    );
  }

  if (activation?.kind === "ready") {
    return (
      <InlineBanner
        body="Automatic photo delivery is active on this phone."
        icon="✓"
        title="This phone is ready"
        tone="success"
      />
    );
  }

  return (
    <InlineBanner
      body="CrewRoll is checking automatic photo delivery on this phone."
      icon="…"
      title="Trip has started"
      tone="info"
    />
  );
}

export function LobbyScreen({
  activation,
  approvingMembershipId,
  endsLabel,
  invite,
  onApproveMember,
  onStart,
  starting = false,
  trip,
}: LobbyScreenProps) {
  const currentMember = trip.members.find(
    (member) =>
      member.membershipId === trip.currentMembershipId &&
      member.isCurrentMember,
  );
  const isOwner = currentMember?.role === "OWNER";
  const mutationActive = approvingMembershipId !== undefined || starting;
  const blocker =
    isOwner && trip.status === "LOBBY" ? startBlockerFor(trip) : null;

  return (
    <Screen testID="lobby-screen">
      <Stack gap="xl">
        <Stack gap="sm">
          <AppText tone="action" variant="eyebrow">
            Immediate trip
          </AppText>
          <AppText accessibilityRole="header" variant="display">
            {trip.name}
          </AppText>
          <AppText tone="secondary">
            New eligible photos can arrive automatically once this trip starts.
          </AppText>
        </Stack>

        <TripSummaryCard
          details={[
            { label: "Ends", value: endsLabel },
            {
              label: "Members",
              value: `${trip.members.length} ${
                trip.members.length === 1 ? "person" : "people"
              }`,
            },
          ]}
          name={trip.name}
          status={tripStatus(trip)}
        />

        {isOwner && trip.status === "LOBBY" && invite ? (
          <InviteCard
            code={invite.code}
            inviteUrl={invite.url}
            onOpenLink={invite.onOpenLink}
            shareAction={{
              accessibilityHint:
                "Opens the system share sheet for this invite.",
              label: "Share invite",
              onPress: invite.onShare,
            }}
          />
        ) : null}

        {!isOwner && currentMember?.status === "PENDING_KEY" ? (
          <InlineBanner
            body="Your request is in. You can join once the owner approves this phone."
            icon="…"
            title="Waiting for the owner"
            tone="warning"
          />
        ) : null}

        <Stack gap="sm">
          <AppText accessibilityRole="header" variant="title2">
            Trip crew
          </AppText>
          {trip.members.map((member) => {
            const readiness = memberReadiness(member);
            const approving = approvingMembershipId === member.membershipId;
            const canApprove =
              isOwner &&
              trip.status === "LOBBY" &&
              member.status === "PENDING_KEY" &&
              onApproveMember !== undefined;

            return (
              <Stack gap="xs" key={member.membershipId}>
                <MemberReadinessRow
                  displayName={member.displayName}
                  readiness={readiness.status}
                  supportingText={readiness.supportingText}
                />
                {canApprove ? (
                  <Button
                    accessibilityHint={`Approves secure trip access for ${member.displayName}.`}
                    disabled={mutationActive && !approving}
                    label={`Approve ${member.displayName}`}
                    loading={approving}
                    onPress={() => onApproveMember(member.membershipId)}
                    variant="secondary"
                  />
                ) : null}
              </Stack>
            );
          })}
        </Stack>

        {trip.status === "ACTIVE" ? (
          <ActiveTripStatus activation={activation} />
        ) : null}

        {isOwner && trip.status === "LOBBY" ? (
          <Stack gap="sm">
            {blocker === null ? (
              <InlineBanner
                body="Everyone is approved and has full photo access."
                icon="✓"
                title="Ready to start"
                tone="success"
              />
            ) : (
              <BlockingCallout
                body={startBlockerCopy(blocker)}
                icon="!"
                title="Trip cannot start yet"
                tone="warning"
              />
            )}
            <Button
              accessibilityHint={
                blocker === null
                  ? "Starts this Immediate trip for every approved member."
                  : startBlockerCopy(blocker)
              }
              disabled={
                blocker !== null || onStart === undefined || mutationActive
              }
              label="Start trip"
              loading={starting}
              onPress={onStart ?? (() => undefined)}
            />
          </Stack>
        ) : null}
      </Stack>
    </Screen>
  );
}
