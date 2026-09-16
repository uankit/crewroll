import { ActivityIndicator, StyleSheet, View } from "react-native";
import { CrewRollWordmark } from "./CrewRollWordmark";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

/** The same quiet brand treatment while auth or native restoration finishes. */
export function BrandLoading() {
  const colors = useCrewRollTheme();
  return (
    <View
      accessibilityLabel="Getting ready"
      accessibilityRole="summary"
      accessibilityState={{ busy: true }}
      accessible
      style={styles.content}
    >
      <CrewRollWordmark />
      <ActivityIndicator color={colors.action} size="small" />
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
