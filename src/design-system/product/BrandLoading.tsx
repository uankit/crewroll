import { ActivityIndicator, StyleSheet, View } from "react-native";
import { CrewRollWordmark } from "./CrewRollWordmark";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { AppText } from "../primitives/AppText";

/** The same quiet brand treatment while auth or native restoration finishes. */
export function BrandLoading({ message }: Readonly<{ message?: string }>) {
  const colors = useCrewRollTheme();
  return (
    <View
      accessibilityLabel={message ?? "Getting ready"}
      accessibilityRole="summary"
      accessibilityState={{ busy: true }}
      accessible
      style={styles.content}
    >
      <CrewRollWordmark />
      <ActivityIndicator color={colors.action} size="small" />
      {message ? <AppText tone="secondary">{message}</AppText> : null}
    </View>
  );
}
const styles = StyleSheet.create({
  content: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.lg,
  },
});
