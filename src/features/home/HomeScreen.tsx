import { StyleSheet, View } from "react-native";

import {
  AppText,
  Button,
  InlineBanner,
  Screen,
  Skeleton,
  spacing,
  Stack,
  StatusBadge,
  Surface,
  TripSummaryCard,
  useCrewRollTheme,
} from "../../design-system";

export type HomeScreenState =
  | Readonly<{ kind: "no-trip" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "trip";
      tripStatus: "ACTIVE" | "LOBBY";
      name: string;
      endsLabel: string;
      memberSummary: string;
      onOpenTrip: () => void;
    }>
  | Readonly<{
      kind: "failed";
      onRetry: () => void;
      retrying?: boolean;
    }>
  | Readonly<{
      kind: "unknown-create" | "unknown-join" | "pending-approval";
      onRecover: () => void;
      recovering?: boolean;
    }>;

export type HomeScreenProps = Readonly<{
  onCreateTrip: () => void;
  onJoinTrip: () => void;
  state?: HomeScreenState;
}>;

function LoadingTrip() {
  return (
    <Surface
      accessibilityLabel="Loading your CrewRoll trip"
      accessibilityRole="summary"
      accessibilityState={{ busy: true }}
      accessible
      style={styles.statusCard}
    >
      <Stack
        accessibilityElementsHidden
        gap="sm"
        importantForAccessibility="no-hide-descendants"
      >
        <Skeleton width="half" />
        <Skeleton />
        <Skeleton width="half" />
      </Stack>
    </Surface>
  );
}

function SafeFailure({
  onRetry,
  retrying = false,
}: Extract<HomeScreenState, { kind: "failed" }>) {
  return (
    <Stack gap="sm" style={styles.statusCard}>
      <InlineBanner
        body="Check your connection and try again. Your trip has not been changed."
        icon="!"
        title="CrewRoll could not load your trip"
        tone="warning"
      />
      <Button
        accessibilityHint="Attempts to load your trip again."
        label="Try again"
        loading={retrying}
        onPress={onRetry}
      />
    </Stack>
  );
}

function UnknownRecovery(
  state: Extract<
    HomeScreenState,
    { kind: "unknown-create" | "unknown-join" | "pending-approval" }
  >,
) {
  const isCreate = state.kind === "unknown-create";
  const isPending = state.kind === "pending-approval";

  return (
    <Stack gap="sm" style={styles.statusCard}>
      <InlineBanner
        body={
          isPending
            ? "Your request is in. Ask the owner to approve this phone. This screen updates automatically while CrewRoll is open."
            : isCreate
              ? "CrewRoll is checking whether your trip was created. Keep this phone connected and check again."
              : "CrewRoll is checking whether your join request was received. Keep this phone connected and check again."
        }
        icon="…"
        title={
          isPending
            ? "Waiting for the owner"
            : isCreate
              ? "Checking your new trip"
              : "Checking your join request"
        }
        tone="info"
      />
      <Button
        accessibilityHint="Safely checks the original request without creating another one."
        label="Check again"
        loading={state.recovering ?? false}
        onPress={state.onRecover}
      />
    </Stack>
  );
}

function HomeTrip({
  endsLabel,
  memberSummary,
  name,
  onOpenTrip,
  tripStatus,
}: Extract<HomeScreenState, { kind: "trip" }>) {
  const active = tripStatus === "ACTIVE";

  return (
    <TripSummaryCard
      action={{
        accessibilityHint: "Opens this trip.",
        label: "Open trip",
        onPress: onOpenTrip,
      }}
      details={[
        { label: "Ends", value: endsLabel },
        { label: "Members", value: memberSummary },
      ]}
      name={name}
      status={{
        icon: active ? "✓" : "…",
        label: active ? "Active" : "Lobby",
        tone: active ? "success" : "info",
      }}
      style={styles.statusCard}
    />
  );
}

function NoTripActions({
  onCreateTrip,
  onJoinTrip,
}: Pick<HomeScreenProps, "onCreateTrip" | "onJoinTrip">) {
  return (
    <>
      <Surface style={styles.statusCard}>
        <StatusBadge icon="○" label="Ready" />
        <View style={styles.statusCopy}>
          <AppText variant="title2">No active trip</AppText>
          <AppText tone="secondary">
            Create a roll or join your friends. Once the trip starts, CrewRoll
            watches for new photos automatically.
          </AppText>
        </View>
      </Surface>

      <View style={styles.actions}>
        <Button
          accessibilityHint="Opens trip creation."
          label="Create a trip"
          onPress={onCreateTrip}
        />
        <Button
          accessibilityHint="Opens invite code entry."
          label="Join a trip"
          onPress={onJoinTrip}
          variant="secondary"
        />
      </View>
    </>
  );
}

export function HomeScreen({
  onCreateTrip,
  onJoinTrip,
  state = { kind: "no-trip" },
}: HomeScreenProps) {
  const colors = useCrewRollTheme();

  const tripContent = (() => {
    switch (state.kind) {
      case "no-trip":
        return (
          <NoTripActions onCreateTrip={onCreateTrip} onJoinTrip={onJoinTrip} />
        );
      case "loading":
        return <LoadingTrip />;
      case "trip":
        return <HomeTrip {...state} />;
      case "failed":
        return <SafeFailure {...state} />;
      case "unknown-create":
      case "unknown-join":
      case "pending-approval":
        return <UnknownRecovery {...state} />;
    }
  })();

  return (
    <Screen testID="home-screen">
      <View style={styles.hero}>
        <AppText variant="eyebrow" tone="action">
          CrewRoll
        </AppText>
        <AppText accessibilityRole="header" variant="display">
          Every trip photo. On every phone.
        </AppText>
        <AppText tone="secondary">
          Keep using your normal camera. CrewRoll privately delivers each
          eligible photo to everyone in the trip.
        </AppText>
      </View>

      {tripContent}

      <Surface muted style={styles.privacyCard}>
        <AppText variant="bodyStrong" style={{ color: colors.info }}>
          Private by design
        </AppText>
        <AppText tone="secondary">
          Photos stay on your phones. Temporary encrypted copies are deleted.
        </AppText>
      </Surface>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: spacing.sm },
  statusCard: { gap: spacing.lg, marginTop: spacing.xxl },
  statusCopy: { gap: spacing.xs },
  actions: { gap: spacing.sm, marginTop: spacing.lg },
  privacyCard: { gap: spacing.xs, marginTop: spacing.lg },
});
