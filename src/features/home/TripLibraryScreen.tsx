import { toUserFacingProblem } from "../../application/problems/userFacingProblem";
import type { ReactNode } from "react";
import type { TripSummary } from "../../domain/trips/model";
import { Pressable, StyleSheet, View } from "react-native";
import {
  AppText,
  Button,
  Screen,
  Stack,
  radius,
  spacing,
  useCrewRollTheme,
} from "../../design-system";
import { HomeHeader } from "./HomeHeader";

export function tripSummaryStatus(trip: TripSummary): string {
  if (trip.participation === "LEAVING" || trip.status === "ENDING")
    return "Finishing sync";
  if (trip.participation === "JOINING") return "Waiting for approval";
  if (trip.status === "LOBBY") return "Gathering your crew";
  return trip.sharingPaused ? "Your sharing is paused" : "Live now";
}
export function TripLibraryScreen({
  accountControl,
  trips,
  onOpenTrip,
  onCreateTrip,
  onJoinTrip,
  refreshing = false,
  error = false,
  canCreateTrip = true,
  inviteUnavailable = false,
  rejoinUnavailable = false,
  onRetry,
  statusContent,
  canOpenTrip = allowOpen,
  sharingReady = true,
}: Readonly<{
  accountControl?: ReactNode;
  trips: readonly TripSummary[];
  onOpenTrip: (trip: TripSummary) => void;
  onCreateTrip: () => void;
  onJoinTrip: () => void;
  refreshing?: boolean;
  error?: boolean;
  canCreateTrip?: boolean;
  inviteUnavailable?: boolean;
  rejoinUnavailable?: boolean;
  onRetry: () => void;
  statusContent?: ReactNode;
  canOpenTrip?: (trip: TripSummary) => boolean;
  sharingReady?: boolean;
}>) {
  const theme = useCrewRollTheme();
  // Ignore stale departed memberships even before a cached response refreshes.
  const current = trips.find((trip) => trip.participation !== "LEFT");
  const canStartTrip = !current && !refreshing && !error && canCreateTrip;
  const live =
    sharingReady &&
    current?.onThisDevice === true &&
    current?.status === "ACTIVE" &&
    current.participation === "JOINED" &&
    !current.sharingPaused;
  return (
    <Screen testID="trip-library-screen" contentStyle={styles.content}>
      <View style={styles.header}>
        <HomeHeader accountControl={accountControl} />
        <AppText accessibilityRole="header" variant="title1">
          Your trips.
        </AppText>
        {statusContent}
        {rejoinUnavailable ? (
          <AppText accessibilityRole="alert" tone="secondary">
            {toUserFacingProblem("TRIP_REJOIN_UNAVAILABLE").message}
          </AppText>
        ) : null}
        {inviteUnavailable ? (
          <AppText accessibilityRole="alert" tone="secondary">
            This invite is no longer available. Ask your host for a new code.
          </AppText>
        ) : null}
        {error ? (
          <Stack gap="xs">
            <AppText tone="critical">Your trips couldn’t refresh.</AppText>
            <Button label="Try again" variant="text" onPress={onRetry} />
          </Stack>
        ) : refreshing && !current ? (
          <AppText tone="secondary">Loading your trips…</AppText>
        ) : null}
        {current ? (
          <Stack gap="sm">
            <AppText variant="eyebrow" tone="secondary">
              CURRENT TRIP
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${current.name}`}
              disabled={!canOpenTrip(current)}
              onPress={() => onOpenTrip(current)}
              style={[
                styles.tripRow,
                {
                  borderBottomColor: theme.border,
                },
              ]}
            >
              <View
                style={[
                  styles.currentAccent,
                  {
                    backgroundColor: live ? theme.success : theme.textSecondary,
                  },
                ]}
              />
              <View style={styles.details}>
                <View style={styles.row}>
                  <AppText variant="headline" style={styles.name}>
                    {current.name}
                  </AppText>
                  {live ? (
                    <AppText variant="caption" style={{ color: theme.success }}>
                      Live
                    </AppText>
                  ) : null}
                </View>
                <AppText variant="caption" tone="secondary">
                  {current.memberCount}{" "}
                  {current.memberCount === 1 ? "person" : "people"} ·{" "}
                  {current.savedPhotoCount} photos
                </AppText>
                {!live ? (
                  <AppText variant="caption" tone="secondary">
                    {!sharingReady &&
                    current.onThisDevice &&
                    current.status === "ACTIVE" &&
                    current.participation === "JOINED" &&
                    !current.sharingPaused
                      ? "Sharing is not ready on this phone"
                      : tripSummaryStatus(current)}
                  </AppText>
                ) : null}
              </View>
              <AppText tone="secondary">›</AppText>
            </Pressable>
          </Stack>
        ) : null}
      </View>
      <View style={styles.footer}>
        <Button
          label="Start a new trip"
          disabled={!canStartTrip}
          onPress={onCreateTrip}
        />
        {!current ? (
          <Button
            label="Enter invite code"
            variant="text"
            disabled={!canStartTrip}
            onPress={onJoinTrip}
          />
        ) : null}
      </View>
    </Screen>
  );
}
function allowOpen() {
  return true;
}
const styles = StyleSheet.create({
  content: { paddingTop: spacing.xs, paddingBottom: spacing.xs },
  header: { flex: 1, gap: spacing.lg, paddingBottom: spacing.sm },
  footer: { gap: spacing.xs, paddingTop: spacing.lg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  tripRow: {
    minHeight: 80,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  currentAccent: { width: 3, alignSelf: "stretch", borderRadius: radius.pill },
  name: { flex: 1 },
  details: { flex: 1, gap: spacing.xxs },
});
