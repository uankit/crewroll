import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { StartBlocker, TripView } from "../../domain/trips/model";
import { startBlockerFor } from "../../domain/trips/startEligibility";
import {
  AppText,
  Button,
  FlowScreen,
  MemberAvatar,
  Sheet,
  Stack,
  TripPhotoGallery,
  radius,
  spacing,
  useCrewRollTheme,
} from "../../design-system";
import { PhotoAccessScreen } from "./PhotoAccessScreen";

export type LobbyInvite = Readonly<{
  code: string;
  onCopy: () => Promise<void>;
}>;

export type LobbyActivationState =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "working" }>
  | Readonly<{
      kind: "failed";
      onRetry: () => void;
      retrying?: boolean;
    }>;

export type LobbyPhotoPermissionState =
  | Readonly<{ kind: "CHECKING" }>
  | Readonly<{ kind: "UNAVAILABLE" }>
  | Readonly<{ kind: "FULL" }>
  | Readonly<{ kind: "REQUESTABLE" }>
  | Readonly<{ kind: "SETTINGS_REQUIRED" }>;

export type LobbyScreenProps = Readonly<{
  trip: TripView;
  endsLabel: string;
  invite?: LobbyInvite;
  onApproveMember?: (membershipId: string) => void;
  approvingMembershipId?: string;
  onStart?: () => void;
  starting?: boolean;
  actionError?: string | null;
  hasPhotos?: boolean;
  filterCount?: number;
  deviceRequestCount?: number;
  onOpenFilters?: () => void;
  onOpenInfo?: () => void;
  onBack?: () => void;
  activation?: LobbyActivationState;
  transferContent?: ReactNode;
  photoPermission: LobbyPhotoPermissionState;
  onRequestPhotoAccess?: () => void;
  onOpenPhotoSettings?: () => void;
}>;

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

export function LobbyScreen({
  trip,
  endsLabel,
  invite,
  onApproveMember,
  approvingMembershipId,
  onStart,
  starting = false,
  activation,
  transferContent,
  photoPermission,
  onRequestPhotoAccess,
  onOpenPhotoSettings,
  actionError,
  hasPhotos = false,
  filterCount = 0,
  deviceRequestCount = 0,
  onOpenFilters,
  onOpenInfo,
  onBack,
}: LobbyScreenProps) {
  const theme = useCrewRollTheme();
  const [deferred, setDeferred] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [copyState, setCopyState] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");
  const copying = useRef(false);
  const [sawFullAccess, setSawFullAccess] = useState(
    photoPermission.kind === "FULL",
  );
  if (photoPermission.kind === "FULL" && !sawFullAccess) setSawFullAccess(true);
  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = setTimeout(() => setCopyState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);
  const current = trip.members.find(
    (m) => m.membershipId === trip.currentMembershipId && m.isCurrentMember,
  );
  const owner = current?.role === "OWNER";
  const lobby = trip.status === "LOBBY";
  const needsPermission =
    current?.status === "ACTIVE" && photoPermission.kind !== "FULL";
  const checking = photoPermission.kind === "CHECKING";
  if (needsPermission && !deferred && (!checking || !sawFullAccess))
    return (
      <PhotoAccessScreen
        checking={checking}
        unavailable={photoPermission.kind === "UNAVAILABLE"}
        settingsRequired={photoPermission.kind === "SETTINGS_REQUIRED"}
        onContinue={
          photoPermission.kind === "SETTINGS_REQUIRED"
            ? (onOpenPhotoSettings ?? (() => {}))
            : (onRequestPhotoAccess ?? (() => {}))
        }
        onLater={() => setDeferred(true)}
      />
    );
  const blocker = owner && lobby ? startBlockerFor(trip) : null;
  const pending = trip.members.filter((m) => m.status === "PENDING_KEY");
  const requestCount = deviceRequestCount + (owner ? pending.length : 0);
  const full = photoPermission.kind === "FULL";
  const title = lobby && !owner ? "Waiting for your host." : trip.name;
  const description = lobby
    ? owner
      ? "Invite your crew, then start when everyone’s here."
      : "Photos will appear here when the trip begins."
    : "Photos arrive here automatically.";
  async function copyCode() {
    if (!invite || copying.current) return;
    copying.current = true;
    setCopyState("copying");
    try {
      await invite.onCopy();
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    } finally {
      copying.current = false;
    }
  }
  return (
    <>
      <FlowScreen
        testID="lobby-screen"
        compact={!lobby}
        centerContent={lobby}
        fillContent={!lobby && !hasPhotos}
        topContent={
          <View style={styles.statusRow}>
            <View
              style={[
                styles.badge,
                {
                  backgroundColor: lobby
                    ? theme.accentSurface
                    : theme.successSurface,
                },
              ]}
            >
              <AppText
                variant="eyebrow"
                style={{ color: lobby ? theme.action : theme.success }}
              >
                {lobby
                  ? "Not started"
                  : trip.status === "ACTIVE"
                    ? "Live"
                    : trip.status === "ENDING"
                      ? "Finishing"
                      : "Trip ended"}
              </AppText>
            </View>
            {owner && lobby ? (
              <Button
                variant="text"
                label="Invite crew"
                onPress={() => setInviteOpen(true)}
                disabled={!invite}
              />
            ) : (
              <Button
                variant={lobby ? "text" : "secondary"}
                style={
                  !lobby
                    ? {
                        backgroundColor: theme.accentSurface,
                        borderWidth: 0,
                        minHeight: 48,
                      }
                    : undefined
                }
                label={filterCount ? `Filters · ${filterCount}` : "Filters"}
                onPress={onOpenFilters ?? (() => {})}
                disabled={!onOpenFilters}
              />
            )}
          </View>
        }
        title={title}
        {...(lobby ? { description } : {})}
        header={
          <View style={styles.navigation}>
            {onBack ? (
              <Button
                variant="text"
                label="‹ Home"
                accessibilityLabel="Back to Home"
                onPress={onBack}
              />
            ) : (
              <View />
            )}
            {onOpenInfo ? (
              <Button
                variant="text"
                label={
                  requestCount ? `Trip info · ${requestCount}` : "Trip info"
                }
                accessibilityLabel={
                  requestCount
                    ? `Trip info, ${requestCount} waiting requests`
                    : "Trip info"
                }
                onPress={onOpenInfo}
              />
            ) : (
              <AppText tone="secondary" variant="label">
                {trip.name}
              </AppText>
            )}
          </View>
        }
        footer={
          lobby ? (
            <>
              {needsPermission ? (
                <Button
                  label="Set up photo access"
                  onPress={() => setDeferred(false)}
                />
              ) : owner ? (
                <Button
                  label="Start trip"
                  loading={starting}
                  disabled={
                    blocker !== null ||
                    !full ||
                    !!approvingMembershipId ||
                    !onStart
                  }
                  onPress={onStart ?? (() => {})}
                />
              ) : null}
              {actionError ? (
                <AppText accessibilityRole="alert" tone="critical">
                  {actionError}
                </AppText>
              ) : null}
              <AppText tone="secondary" variant="caption" style={styles.center}>
                {owner && blocker
                  ? startBlockerCopy(blocker)
                  : lobby && !owner
                    ? "We’ll update this automatically when your host starts."
                    : "Photos appear here automatically."}
              </AppText>
            </>
          ) : needsPermission ? (
            <Button
              label="Set up photo access"
              onPress={() => setDeferred(false)}
            />
          ) : undefined
        }
      >
        {lobby ? (
          <TripPhotoGallery photos={[]} emptyState="waiting" />
        ) : (
          transferContent
        )}
        {owner && lobby && pending.length > 0 ? (
          <Stack gap="sm">
            <AppText variant="bodyStrong">Join requests</AppText>
            {pending.map((member) => (
              <View key={member.membershipId} style={styles.member}>
                <MemberAvatar displayName={member.displayName} />
                <View style={styles.memberName}>
                  <AppText variant="bodyStrong">{member.displayName}</AppText>
                  <AppText variant="caption" tone="secondary">
                    Wants to join your trip
                  </AppText>
                </View>
                <Button
                  accessibilityLabel={`Approve ${member.displayName}`}
                  label="Approve"
                  variant="text"
                  loading={approvingMembershipId === member.membershipId}
                  disabled={
                    !!approvingMembershipId &&
                    approvingMembershipId !== member.membershipId
                  }
                  onPress={() => onApproveMember?.(member.membershipId)}
                />
              </View>
            ))}
          </Stack>
        ) : null}
        {activation?.kind === "failed" ? (
          <Stack gap="sm">
            <AppText accessibilityRole="alert" tone="critical">
              Photo sharing needs to reconnect on this phone.
            </AppText>
            <Button
              label="Try again"
              loading={activation.retrying ?? false}
              onPress={activation.onRetry}
            />
          </Stack>
        ) : null}
      </FlowScreen>
      {invite ? (
        <Sheet
          visible={inviteOpen}
          title="Invite your crew"
          showCloseButton={false}
          onDismiss={() => setInviteOpen(false)}
        >
          <AppText tone="secondary">
            Send this code to everyone joining {trip.name}.
          </AppText>
          <AppText variant="label">
            {trip.name} · {endsLabel}
          </AppText>
          <View style={[styles.code, { backgroundColor: theme.surfaceMuted }]}>
            <AppText selectable variant="title2">
              {invite.code.slice(0, 4)} {invite.code.slice(4)}
            </AppText>
          </View>
          <Button
            label={copyState === "copied" ? "Code copied" : "Copy code"}
            loading={copyState === "copying"}
            onPress={() => void copyCode()}
          />
          {copyState === "copied" ? (
            <AppText
              accessibilityLiveRegion="polite"
              variant="caption"
              tone="secondary"
              style={styles.center}
            >
              Send it to your crew.
            </AppText>
          ) : null}
          {copyState === "failed" ? (
            <AppText accessibilityRole="alert" tone="critical">
              The code couldn’t be copied. Try again.
            </AppText>
          ) : null}
        </Sheet>
      ) : null}
    </>
  );
}
const styles = StyleSheet.create({
  navigation: {
    minHeight: 48,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    alignItems: "center",
    justifyContent: "space-between",
  },
  inviteAction: {
    minHeight: 48,
    paddingHorizontal: spacing.sm,
    justifyContent: "center",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.xs,
  },
  badge: {
    minHeight: 32,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    justifyContent: "center",
  },
  center: { textAlign: "center" },
  code: {
    minHeight: 72,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  member: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  memberName: { flex: 1 },
});
