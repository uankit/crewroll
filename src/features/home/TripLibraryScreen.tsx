import type { TripSummary } from "../../domain/trips/model";
import { Pressable, StyleSheet, View } from "react-native";
import {
  AppText,
  Button,
  CrewRollWordmark,
  FlowScreen,
  Stack,
  radius,
  spacing,
  useCrewRollTheme,
} from "../../design-system";

export function tripSummaryStatus(trip: TripSummary): string {
  if (trip.participation === "LEFT")
    return trip.status === "INCOMPLETE_EXPIRED"
      ? "Some photos weren’t synced"
      : trip.status === "CANCELLED"
        ? "Cancelled"
        : "Past trip";
  if (trip.participation === "LEAVING") return "Finishing sync";
  if (trip.participation === "JOINING") return "Waiting for approval";
  if (trip.status === "LOBBY") return "Ready when you are";
  return trip.sharingPaused ? "Your sharing is paused" : "Live now";
}
export function TripLibraryScreen({
  trips,
  onOpenTrip,
  onCreateTrip,
  onJoinTrip,
  refreshing = false,
  error = false,
  onRetry,
}: Readonly<{
  trips: readonly TripSummary[];
  onOpenTrip: (trip: TripSummary) => void;
  onCreateTrip: () => void;
  onJoinTrip: () => void;
  refreshing?: boolean;
  error?: boolean;
  onRetry: () => void;
}>) {
  const theme = useCrewRollTheme();
  const current = trips.find((trip) => trip.participation !== "LEFT");
  const previous = trips.filter((trip) => trip.participation === "LEFT");
  return (
    <FlowScreen
      header={<CrewRollWordmark />}
      title="Your trips."
      testID="trip-library-screen"
      footer={
        !current && !refreshing && !error ? (
          <>
            <Button label="Start a trip" onPress={onCreateTrip} />
            <Button
              label="Enter invite code"
              variant="text"
              onPress={onJoinTrip}
            />
          </>
        ) : undefined
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
              styles.current,
              {
                backgroundColor: theme.surfaceMuted,
                borderColor: theme.border,
              },
            ]}
          >
            <AppText variant="label" tone="action">
              {tripSummaryStatus(current)}
            </AppText>
            <AppText variant="title2">{current.name}</AppText>
            <View style={styles.row}>
              <AppText variant="label" tone="secondary">
                {current.memberCount}{" "}
                {current.memberCount === 1 ? "person" : "people"} ·{" "}
                {current.savedPhotoCount} photos
              </AppText>
              <AppText tone="action">→</AppText>
            </View>
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
              style={[styles.past, { borderColor: theme.border }]}
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
  current: {
    padding: spacing.xl,
    gap: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  past: {
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  details: { flex: 1, gap: spacing.xs },
});
