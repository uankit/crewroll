import { StyleSheet, View } from "react-native";

import {
  AppText,
  Button,
  Screen,
  spacing,
  StatusBadge,
  Surface,
  useCrewRollTheme,
} from "../../design-system";

type HomeScreenProps = {
  onCreateTrip: () => void;
  onJoinTrip: () => void;
};

export function HomeScreen({ onCreateTrip, onJoinTrip }: HomeScreenProps) {
  const colors = useCrewRollTheme();

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
          Keep using your normal camera. CrewRoll privately delivers each eligible
          photo to everyone in the trip.
        </AppText>
      </View>

      <Surface style={styles.statusCard}>
        <StatusBadge label="Ready" />
        <View style={styles.statusCopy}>
          <AppText variant="title2">No active trip</AppText>
          <AppText tone="secondary">
            Create a roll or join your friends. Once the trip starts, CrewRoll watches
            for new photos automatically.
          </AppText>
        </View>
      </Surface>

      <View style={styles.actions}>
        <Button label="Create a trip" onPress={onCreateTrip} />
        <Button label="Join a trip" onPress={onJoinTrip} variant="secondary" />
      </View>

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
