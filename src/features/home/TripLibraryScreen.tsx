import type { ReactNode } from "react";
import type { TripSummary } from "../../domain/trips/model";
import { Pressable, StyleSheet, View } from "react-native";
import {
  AppText,
  Button,
  FlowScreen,
  Stack,
  radius,
  spacing,
  useCrewRollTheme,
} from "../../design-system";
import { HomeHeader } from "./HomeHeader";

export function tripSummaryStatus(trip: TripSummary): string {
  if (trip.participation === "LEFT")
    return trip.status === "INCOMPLETE_EXPIRED"
      ? "Some photos weren’t synced"
      : trip.status === "CANCELLED"
        ? "Cancelled"
        : "Past trip";
  if (trip.participation === "LEAVING") return "Finishing sync";
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
  onRetry,
}: Readonly<{
  accountControl?: ReactNode;
  trips: readonly TripSummary[];
  onOpenTrip: (trip: TripSummary) => void;
  onCreateTrip: () => void;
  onJoinTrip: () => void;
  refreshing?: boolean;
  error?: boolean;
  canCreateTrip?: boolean;
  onRetry: () => void;
}>) {
  const theme = useCrewRollTheme();
  const current = trips.find((trip) => trip.participation !== "LEFT");
  const previous = trips.filter((trip) => trip.participation === "LEFT");
  const canStartTrip = !current && !refreshing && !error && canCreateTrip;
  const live =
    current?.status === "ACTIVE" &&
    current.participation === "JOINED" &&
    !current.sharingPaused;
  return (
    <FlowScreen
      header={<HomeHeader accountControl={accountControl} />}
      title="Your trips."
      testID="trip-library-screen"
      footer={
        <>
          <Button
            label="Start a new trip"
            disabled={!canStartTrip}
            onPress={onCreateTrip}
          />
          {canStartTrip ? (
            <Button
              label="Enter invite code"
              variant="text"
              onPress={onJoinTrip}
            />
          ) : null}
        </>
      }
    >
      {current ? (
        <Stack gap="sm">
          <AppText variant="eyebrow" tone="secondary">
            CURRENT TRIP
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${current.name}`}
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
                { backgroundColor: live ? theme.success : theme.textSecondary },
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
                  {tripSummaryStatus(current)}
                </AppText>
              ) : null}
            </View>
            <AppText tone="secondary">›</AppText>
          </Pressable>
        </Stack>
      ) : null}
      {previous.length ? (
        <Stack gap="sm">
          <AppText variant="eyebrow" tone="secondary">
            PAST TRIPS
          </AppText>
          {previous.map((trip) => (
            <Pressable
              key={trip.id}
              accessibilityRole="button"
              accessibilityLabel={`View ${trip.name}`}
              onPress={() => onOpenTrip(trip)}
              style={[
                styles.tripRow,
                styles.past,
                { borderBottomColor: theme.border },
              ]}
            >
              <View style={styles.details}>
                <AppText variant="headline">{trip.name}</AppText>
                <AppText variant="caption" tone="secondary">
                  {new Date(trip.startsAt ?? trip.endsAt).toLocaleDateString(
                    undefined,
                    { month: "short", day: "numeric", year: "numeric" },
                  )}{" "}
                  · {trip.savedPhotoCount} saved
                </AppText>
              </View>
              <AppText tone="secondary">›</AppText>
            </Pressable>
          ))}
        </Stack>
      ) : null}
      {error ? (
        <Stack gap="xs">
          <AppText tone="critical">Your trips couldn’t refresh.</AppText>
          <Button label="Try again" variant="text" onPress={onRetry} />
        </Stack>
      ) : refreshing && !trips.length ? (
        <AppText tone="secondary">Loading your trips…</AppText>
      ) : null}
    </FlowScreen>
  );
}
const styles = StyleSheet.create({
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
  past: { paddingLeft: spacing.sm + 3 },
  name: { flex: 1 },
  details: { flex: 1, gap: spacing.xxs },
});
