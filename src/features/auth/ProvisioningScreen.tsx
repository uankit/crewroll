import { ActivityIndicator, StyleSheet, View } from "react-native";

import {
  AppText,
  Button,
  Screen,
  spacing,
  Stack,
  Surface,
  useCrewRollTheme,
} from "../../design-system";

const safeFailure =
  "CrewRoll could not connect this phone. Check your connection and try again.";

export type ProvisioningScreenProps =
  | Readonly<{
      status: "working";
      onRetry?: never;
      retrying?: never;
    }>
  | Readonly<{
      status: "failed";
      onRetry: () => void;
      retrying?: boolean;
    }>;

export function ProvisioningScreen(props: ProvisioningScreenProps) {
  const colors = useCrewRollTheme();
  const working = props.status === "working";

  return (
    <Screen contentStyle={styles.content} testID="provisioning-screen">
      <Stack gap="xl" justify="center" style={styles.layout}>
        <Stack gap="sm">
          <AppText tone="action" variant="eyebrow">
            CrewRoll
          </AppText>
          <AppText accessibilityRole="header" variant="display">
            Connecting this phone
          </AppText>
          <AppText tone="secondary">
            CrewRoll creates a secure identity for this phone before your trip
            photos can arrive.
          </AppText>
        </Stack>

        {working ? (
          <Surface
            accessibilityLabel="Connecting this phone. Secure phone setup is in progress."
            accessibilityRole="summary"
            accessibilityState={{ busy: true }}
            accessible
            style={styles.statusCard}
            testID="provisioning-progress"
          >
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <ActivityIndicator color={colors.action} size="large" />
            </View>
            <Stack gap="xs">
              <AppText aria-hidden variant="title2">
                Secure setup in progress
              </AppText>
              <AppText aria-hidden tone="secondary">
                Keep CrewRoll open for a moment.
              </AppText>
            </Stack>
          </Surface>
        ) : (
          <Stack gap="md">
            <Surface
              accessibilityLabel={safeFailure}
              accessibilityRole="alert"
              accessible
              muted
              style={styles.statusCard}
              testID="provisioning-failure"
            >
              <AppText aria-hidden tone="critical" variant="title2">
                This phone is not connected yet
              </AppText>
              <AppText aria-hidden tone="secondary">
                {safeFailure}
              </AppText>
            </Surface>
            <Button
              accessibilityHint="Attempts secure phone setup again."
              label="Try again"
              loading={props.retrying ?? false}
              onPress={props.onRetry}
            />
          </Stack>
        )}
      </Stack>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { justifyContent: "center" },
  layout: { flex: 1 },
  statusCard: { gap: spacing.md },
});
