import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { StartBlocker, TripView } from "../../domain/trips/model";
import { startBlockerFor } from "../../domain/trips/startEligibility";
import {
  AppIcon,
  AppText,
  IconButton,
  Button,
  FlowScreen,
  MemberAvatar,
  Sheet,
  Stack,
  radius,
  spacing,
  useCrewRollTheme,
} from "../../design-system";
import { PhotoAccessScreen } from "./PhotoAccessScreen";
import type { ScrollRestoration } from "../../design-system";

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
  inviteStatus?: "loading" | "failed";
  onRetryInvite?: () => void;
  onOpenNotifications?: () => void;
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
  scrollRestoration?: ScrollRestoration;
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
  inviteStatus = "loading",
  onRetryInvite,
  onOpenNotifications,
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
  scrollRestoration,
}: LobbyScreenProps) {
  const theme = useCrewRollTheme();
  const [photoSetupOpen, setPhotoSetupOpen] = useState(false);
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
  const checking = photoPermission.kind === "CHECKING";
  const needsPermission =
    current?.status === "ACTIVE" &&
    !checking &&
    photoPermission.kind !== "FULL";
  // Initial setup belongs to account onboarding. A skipped/revoked grant must
  // not replace the trip; let the user explicitly reopen the same explainer.
  if (needsPermission && photoSetupOpen)
    return (
      <PhotoAccessScreen
        {...(actionError ? { error: actionError } : {})}
        checking={checking}
        unavailable={photoPermission.kind === "UNAVAILABLE"}
        settingsRequired={photoPermission.kind === "SETTINGS_REQUIRED"}
        onContinue={
          photoPermission.kind === "SETTINGS_REQUIRED"
            ? (onOpenPhotoSettings ?? (() => {}))
            : (onRequestPhotoAccess ?? (() => {}))
        }
        onLater={() => setPhotoSetupOpen(false)}
      />
    );
  const blocker = owner && lobby ? startBlockerFor(trip) : null;
  const pending = trip.members.filter((m) => m.status === "PENDING_KEY");
  const joined = trip.members.filter((m) => m.status === "ACTIVE");
  const requestCount = deviceRequestCount + (owner ? pending.length : 0);
  const full = photoPermission.kind === "FULL";
  const permissionSyncPending =
    full && current?.fullPhotoLibraryAccess === false;
  const alone = joined.length === 1 && pending.length === 0;
  const startExplanation = checking
    ? "Checking photo access on this phone…"
    : needsPermission
      ? "Allow full photo access before starting."
      : blocker === "MEMBER_NEEDS_FULL_ACCESS" && permissionSyncPending
        ? "Finishing photo setup on this phone…"
        : blocker
          ? startBlockerCopy(blocker)
          : !onStart
            ? "Connecting to your trip…"
            : "Start whenever you’re ready. Others can join later.";
  const title = lobby ? "Who’s coming along?" : trip.name;
  const description = lobby
    ? owner
      ? "Send the invite. Your friends will appear here as they join."
      : "Waiting for your host. Photos begin when the trip starts."
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
        {...(scrollRestoration ? { scrollRestoration } : {})}
        testID="lobby-screen"
        compact={!lobby}
        fillContent={!lobby && !hasPhotos}
        topContent={
          !lobby ? (
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.badge,
                  {
                    backgroundColor: theme.successSurface,
                  },
                ]}
              >
                <AppText variant="eyebrow" style={{ color: theme.success }}>
                  {trip.status === "ACTIVE"
                    ? "Live"
                    : trip.status === "ENDING"
                      ? "Finishing"
                      : "Trip ended"}
                </AppText>
              </View>
              <Button
                variant="secondary"
                style={{
                  backgroundColor: theme.accentSurface,
                  borderWidth: 0,
                  minHeight: 48,
                }}
                label={filterCount ? `Filters · ${filterCount}` : "Filters"}
                onPress={onOpenFilters ?? (() => {})}
                disabled={!onOpenFilters}
              />
            </View>
          ) : undefined
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
            <View style={styles.headerActions}>
              {((!lobby && owner) || requestCount > 0) &&
              onOpenNotifications ? (
                <View>
                  <IconButton
                    label={
                      requestCount
                        ? `Notifications, ${requestCount} pending ${requestCount === 1 ? "request" : "requests"}`
                        : "Notifications"
                    }
                    accessibilityHint="Review requests to join your trip and confirm phones"
                    icon={<AppIcon name="bell" />}
                    onPress={onOpenNotifications}
                    style={{
                      backgroundColor: theme.transparent,
                      borderWidth: 0,
                    }}
                  />
                  {requestCount > 0 ? (
                    <View
                      pointerEvents="none"
                      accessible={false}
                      style={[
                        styles.requestBadge,
                        {
                          backgroundColor: theme.action,
                          borderColor: theme.background,
                        },
                      ]}
                    >
                      <AppText
                        variant="caption"
                        tone="onAction"
                        style={styles.requestCount}
                      >
                        {requestCount > 99 ? "99+" : requestCount}
                      </AppText>
                    </View>
                  ) : null}
                </View>
              ) : null}
              {onOpenInfo ? (
                <IconButton
                  label="Trip settings"
                  accessibilityHint="Trip details, invite code, crew and sharing controls"
                  icon={<AppIcon name="settings" />}
                  onPress={onOpenInfo}
                  style={{ backgroundColor: theme.transparent, borderWidth: 0 }}
                />
              ) : null}
            </View>
          </View>
        }
        footer={
          lobby ? (
            <>
              {needsPermission ? (
                <Button
                  label="Set up photo access"
                  onPress={() => setPhotoSetupOpen(true)}
                />
              ) : owner ? (
                <>
                  <Button
                    label="Invite crew"
                    onPress={() => setInviteOpen(true)}
                  />
                  <Button
                    label="Start trip"
                    variant="secondary"
                    loading={starting}
                    disabled={blocker !== null || !full || !onStart}
                    accessibilityHint={startExplanation}
                    onPress={onStart ?? (() => {})}
                  />
                </>
              ) : null}
              {actionError ? (
                <AppText accessibilityRole="alert" tone="critical">
                  {actionError}
                </AppText>
              ) : null}
              {owner ? (
                <AppText
                  tone="secondary"
                  variant="caption"
                  style={styles.center}
                >
                  {startExplanation}
                </AppText>
              ) : !owner ? (
                <AppText
                  tone="secondary"
                  variant="caption"
                  style={styles.center}
                >
                  We’ll update this automatically when your host starts.
                </AppText>
              ) : null}
            </>
          ) : needsPermission ? (
            <Button
              label="Set up photo access"
              onPress={() => setPhotoSetupOpen(true)}
            />
          ) : undefined
        }
      >
        {lobby ? (
          <Stack gap="lg" testID="lobby-crew">
            {!alone ? (
              <AppText
                variant="caption"
                tone="secondary"
                accessibilityLiveRegion="polite"
              >
                {joined.length} joined
                {pending.length ? ` · ${pending.length} waiting` : ""}
              </AppText>
            ) : null}
            <View accessibilityLiveRegion="polite">
              {[...joined, ...pending].map((member) => (
                <View
                  key={member.membershipId}
                  style={[
                    styles.member,
                    styles.joinedMember,
                    { borderBottomColor: theme.border },
                  ]}
                >
                  <MemberAvatar
                    displayName={
                      member.isCurrentMember ? "You" : member.displayName
                    }
                  />
                  <View style={styles.memberName}>
                    <AppText variant="bodyStrong">
                      {member.isCurrentMember ? "You" : member.displayName}
                      {member.role === "OWNER" ? " · Host" : ""}
                    </AppText>
                  </View>
                  <AppText
                    variant="caption"
                    tone="secondary"
                    style={styles.readiness}
                  >
                    {member.status === "PENDING_KEY"
                      ? "Waiting for approval"
                      : member.isCurrentMember && checking
                        ? "Checking photos…"
                        : member.isCurrentMember && !full
                          ? "Photo access needed"
                          : !member.fullPhotoLibraryAccess
                            ? member.isCurrentMember && full
                              ? "Finishing setup…"
                              : "Setting up photos"
                            : member.deviceState === "MISSING"
                              ? "Connecting…"
                              : "Ready"}
                  </AppText>
                </View>
              ))}
              {alone ? (
                <View
                  testID="crew-placeholders"
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  {[0, 1, 2].map((slot) => (
                    <View
                      key={slot}
                      style={[styles.member, styles.placeholder]}
                    >
                      <View
                        style={[
                          styles.placeholderAvatar,
                          { borderColor: theme.border },
                        ]}
                      />
                      <View style={styles.placeholderLine}>
                        {Array.from(
                          { length: slot === 1 ? 12 : 16 },
                          (_, dot) => (
                            <View
                              key={dot}
                              style={[
                                styles.placeholderDot,
                                { backgroundColor: theme.border },
                              ]}
                            />
                          ),
                        )}
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          </Stack>
        ) : checking && !sawFullAccess ? (
          <AppText
            variant="caption"
            tone="secondary"
            accessibilityLiveRegion="polite"
          >
            Loading photos…
          </AppText>
        ) : (
          transferContent
        )}
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
      {owner ? (
        <Sheet
          visible={inviteOpen}
          title="Invite your crew"
          showCloseButton={false}
          onDismiss={() => setInviteOpen(false)}
        >
          <AppText tone="secondary">
            Send this code to everyone coming along.
          </AppText>
          <AppText variant="caption" tone="secondary">
            {trip.name}
            {"\n"}Sharing ends {endsLabel}
          </AppText>
          {invite ? (
            <>
              <View
                style={[styles.code, { backgroundColor: theme.surfaceMuted }]}
              >
                <AppText selectable variant="title2">
                  {invite.code.slice(0, 4)} {invite.code.slice(4)}
                </AppText>
              </View>
              <Button
                label={copyState === "copied" ? "Code copied" : "Copy code"}
                loading={copyState === "copying"}
                onPress={() => void copyCode()}
              />
              {copyState === "failed" ? (
                <AppText accessibilityRole="alert" tone="critical">
                  The code couldn’t be copied. Try again.
                </AppText>
              ) : null}
            </>
          ) : (
            <Stack gap="md">
              <AppText tone="secondary" accessibilityLiveRegion="polite">
                {inviteStatus === "failed"
                  ? "The invite code couldn’t load. Your trip is saved."
                  : "Getting your invite code…"}
              </AppText>
              <Button
                label={inviteStatus === "failed" ? "Try again" : "Getting code"}
                loading={inviteStatus === "loading"}
                onPress={onRetryInvite ?? (() => {})}
                disabled={!onRetryInvite}
              />
            </Stack>
          )}
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
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xxs,
  },
  requestBadge: {
    position: "absolute",
    right: 0,
    top: 0,
    minWidth: 20,
    minHeight: 20,
    paddingHorizontal: spacing.xxs,
    borderRadius: radius.pill,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  requestCount: { fontSize: 10, lineHeight: 14 },
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
  joinedMember: {
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  readiness: { maxWidth: 100, textAlign: "right" },
  placeholder: { minHeight: 76, opacity: 0.8 },
  placeholderAvatar: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderStyle: "dashed",
  },
  placeholderLine: { flexDirection: "row", gap: spacing.xs },
  placeholderDot: { width: 3, height: 3, borderRadius: radius.pill },
});
