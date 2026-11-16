import { useEffect, useRef, useState, type ReactNode } from "react";
import { BackHandler, StyleSheet, View } from "react-native";
import type { StartBlocker, TripView } from "../../domain/trips/model";
import { startBlockerFor } from "../../domain/trips/startEligibility";
import {
  AppIcon,
  AppText,
  IconButton,
  Button,
  FlowScreen,
  CrewRollHeader,
  MemberAvatar,
  Sheet,
  Stack,
  radius,
  spacing,
  useCrewRollTheme,
} from "../../design-system";
import { PhotoAccessScreen } from "./PhotoAccessScreen";
import type { PhotoAccessReason } from "../../domain/trips/photoAccess";
import { JoinRequestRow } from "./JoinRequestRow";
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

export type LobbyPhotoPermissionState = (
  | Readonly<{ kind: "CHECKING" }>
  | Readonly<{ kind: "UNAVAILABLE" }>
  | Readonly<{ kind: "FULL" }>
  | Readonly<{ kind: "REQUESTABLE" }>
  | Readonly<{ kind: "SETTINGS_REQUIRED" }>
) &
  Readonly<{ reason?: PhotoAccessReason }>;

export type LobbyScreenProps = Readonly<{
  accountControl?: ReactNode;
  trip: TripView;
  endsLabel: string;
  invite?: LobbyInvite;
  inviteStatus?: "loading" | "failed";
  onRetryInvite?: () => void;
  onOpenNotifications?: () => void;
  memberRequests?: Readonly<{
    approvedIds?: readonly string[];
    declinedIds?: readonly string[];
    busy: { id: string; action: "approve" | "decline" } | null;
    error: { id: string; message: string } | null;
    onResolve: (membershipId: string, approve: boolean) => void;
  }>;
  photoReadinessFailed?: boolean;
  onRetryPhotoReadiness?: () => void;
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
  canManageTrip?: boolean;
  sharingReady?: boolean;
  statusContent?: ReactNode;
}>;

function startBlockerCopy(blocker: StartBlocker): string {
  switch (blocker) {
    case "OWNER_ONLY":
      return "Only the trip owner can start this trip.";
    case "NOT_LOBBY":
      return "This trip cannot be started from its current state.";
    case "MEMBER_PENDING_KEY":
      return "Approve every waiting member before starting.";
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
  memberRequests,
  photoReadinessFailed = false,
  onRetryPhotoReadiness,
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
  canManageTrip = true,
  sharingReady = true,
  statusContent,
  accountControl,
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
  const showingPhotoSetup =
    canManageTrip &&
    photoSetupOpen &&
    current?.status === "ACTIVE" &&
    photoPermission.kind !== "FULL";
  useEffect(() => {
    if (!showingPhotoSetup) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        setPhotoSetupOpen(false);
        return true;
      },
    );
    return () => subscription.remove();
  }, [showingPhotoSetup]);
  // Photo setup belongs to the sharing intent. A missing/revoked grant must not
  // replace the trip; let the user explicitly open the same explainer here.
  if (showingPhotoSetup)
    return (
      <PhotoAccessScreen
        {...(accountControl ? { accountControl } : {})}
        {...(actionError ? { error: actionError } : {})}
        checking={checking}
        unavailable={photoPermission.kind === "UNAVAILABLE"}
        settingsRequired={photoPermission.kind === "SETTINGS_REQUIRED"}
        reason={photoPermission.reason}
        onContinue={
          photoPermission.kind === "UNAVAILABLE"
            ? (onRetryPhotoReadiness ?? (() => {}))
            : photoPermission.kind === "SETTINGS_REQUIRED"
              ? (onOpenPhotoSettings ?? (() => {}))
              : (onRequestPhotoAccess ?? (() => {}))
        }
        onLater={() => setPhotoSetupOpen(false)}
      />
    );
  const blocker = owner && lobby ? startBlockerFor(trip) : null;
  const approvedIds = memberRequests?.approvedIds ?? [];
  const declinedIds = memberRequests?.declinedIds ?? [];
  const pending = trip.members.filter(
    (m) =>
      m.status === "PENDING_KEY" &&
      !approvedIds.includes(m.membershipId) &&
      !declinedIds.includes(m.membershipId),
  );
  const joined = trip.members.filter(
    (m) => m.status === "ACTIVE" || approvedIds.includes(m.membershipId),
  );
  const declined = trip.members.filter(
    (m) => m.status === "PENDING_KEY" && declinedIds.includes(m.membershipId),
  );
  const requestCount =
    deviceRequestCount + (!lobby && owner ? pending.length : 0);
  const alone = joined.length === 1 && pending.length === 0;
  const startExplanation = !canManageTrip
    ? "Getting your trip ready…"
    : blocker
      ? blocker === "MEMBER_PENDING_KEY" && pending.length === 0
        ? "Updating your crew…"
        : startBlockerCopy(blocker)
      : !onStart
        ? "Getting your trip ready…"
        : "Start whenever you’re ready. Others can join later.";
  const title = lobby ? "Who’s coming along?" : trip.name;
  const description = lobby
    ? owner
      ? "Send the invite. Your friends will appear here as they join."
      : "Waiting for your host. Photos begin when the trip starts."
    : "Photos arrive here automatically.";
  const centeredRecovery =
    !lobby &&
    !hasPhotos &&
    !needsPermission &&
    (Boolean(statusContent) ||
      activation?.kind === "failed" ||
      activation?.kind === "working");
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
        pinnedHeader
        compact={!lobby}
        centerContent={centeredRecovery}
        fillContent={!lobby && !hasPhotos && !centeredRecovery}
        topContent={
          !lobby ? (
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.badge,
                  {
                    backgroundColor: sharingReady
                      ? theme.successSurface
                      : theme.surfaceMuted,
                  },
                ]}
              >
                <AppText
                  variant="eyebrow"
                  style={{
                    color: sharingReady ? theme.success : theme.textSecondary,
                  }}
                >
                  {trip.status === "ACTIVE"
                    ? sharingReady
                      ? "Live"
                      : "Trip active"
                    : trip.status === "ENDING"
                      ? "Finishing"
                      : "Trip ended"}
                </AppText>
              </View>
              {!centeredRecovery || hasPhotos || filterCount > 0 ? (
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
              ) : null}
            </View>
          ) : undefined
        }
        title={title}
        {...(lobby ? { description } : {})}
        header={
          <CrewRollHeader accountControl={accountControl}>
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
                    style={{
                      backgroundColor: theme.transparent,
                      borderWidth: 0,
                    }}
                  />
                ) : null}
              </View>
            </View>
          </CrewRollHeader>
        }
        footer={
          lobby ? (
            <>
              {owner ? (
                <>
                  <Button
                    label="Invite crew"
                    disabled={!canManageTrip}
                    onPress={() => setInviteOpen(true)}
                  />
                  <Button
                    label="Start trip"
                    variant="secondary"
                    loading={starting}
                    disabled={blocker !== null || !canManageTrip || !onStart}
                    accessibilityHint={startExplanation}
                    onPress={onStart ?? (() => {})}
                  />
                </>
              ) : null}
              {needsPermission ? (
                <Stack gap="sm">
                  <AppText
                    tone="secondary"
                    variant="caption"
                    style={styles.center}
                  >
                    Photo sharing is paused on this phone.
                  </AppText>
                  <Button
                    label="Set up photo access"
                    variant="secondary"
                    disabled={!canManageTrip}
                    onPress={() => setPhotoSetupOpen(true)}
                  />
                </Stack>
              ) : null}
              {actionError ? (
                <AppText accessibilityRole="alert" tone="critical">
                  {actionError}
                </AppText>
              ) : null}
              {photoReadinessFailed && onRetryPhotoReadiness ? (
                <Button
                  label="Retry photo setup"
                  variant="text"
                  disabled={!canManageTrip}
                  onPress={onRetryPhotoReadiness}
                />
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
                  {photoReadinessFailed
                    ? "Photo setup couldn’t sync. We’ll keep trying."
                    : "We’ll update this automatically when your host starts."}
                </AppText>
              ) : null}
            </>
          ) : needsPermission ? (
            <Button
              label="Set up photo access"
              disabled={!canManageTrip}
              onPress={() => setPhotoSetupOpen(true)}
            />
          ) : undefined
        }
      >
        {statusContent}
        {!statusContent && activation?.kind === "failed" ? (
          <Stack gap="sm" testID="sharing-recovery">
            <AppText accessibilityRole="header" variant="headline">
              Sharing is paused on this phone
            </AppText>
            <AppText accessibilityRole="alert" tone="secondary">
              {trip.status === "ENDING"
                ? "Your trip is finishing. Reconnect sharing to continue."
                : "Your trip is active. Reconnect sharing to continue."}
            </AppText>
            <Button
              label="Reconnect sharing"
              variant={hasPhotos ? "secondary" : "primary"}
              loading={activation.retrying ?? false}
              disabled={!canManageTrip}
              onPress={activation.onRetry}
            />
          </Stack>
        ) : !statusContent && activation?.kind === "working" ? (
          <Stack gap="sm">
            <AppText accessibilityRole="header" variant="headline">
              Preparing photo sharing
            </AppText>
            <AppText tone="secondary" accessibilityLiveRegion="polite">
              Getting sharing ready on this phone.
            </AppText>
            <Button label="Reconnect sharing" loading onPress={() => {}} />
          </Stack>
        ) : null}
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
              {[...joined, ...declined, ...pending].map((member) =>
                owner &&
                member.status === "PENDING_KEY" &&
                !approvedIds.includes(member.membershipId) &&
                !declinedIds.includes(member.membershipId) &&
                memberRequests ? (
                  <View key={member.membershipId}>
                    <JoinRequestRow
                      name={member.displayName}
                      description="Wants to join"
                      busy={
                        memberRequests.busy?.id === member.membershipId
                          ? memberRequests.busy.action
                          : null
                      }
                      disabled={memberRequests.busy !== null}
                      onApprove={() =>
                        memberRequests.onResolve(member.membershipId, true)
                      }
                      onDecline={() =>
                        memberRequests.onResolve(member.membershipId, false)
                      }
                    />
                    {memberRequests.error?.id === member.membershipId ? (
                      <AppText
                        variant="caption"
                        tone="critical"
                        accessibilityRole="alert"
                      >
                        {memberRequests.error.message}
                      </AppText>
                    ) : null}
                  </View>
                ) : (
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
                        ? declinedIds.includes(member.membershipId)
                          ? "Declined"
                          : approvedIds.includes(member.membershipId)
                            ? "Approved"
                            : "Waiting for approval"
                        : member.isCurrentMember && !canManageTrip
                          ? "Preparing…"
                          : member.deviceState === "MISSING"
                            ? "Connecting…"
                            : "Joined"}
                    </AppText>
                  </View>
                ),
              )}
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
        ) : !centeredRecovery ? (
          transferContent
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
                disabled={!onRetryInvite || !canManageTrip}
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
