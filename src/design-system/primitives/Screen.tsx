import type { PropsWithChildren } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

type ScreenProps = PropsWithChildren<{
  scroll?: boolean;
  testID?: string;
}>;

export function Screen({ children, scroll = true, testID }: ScreenProps) {
  const colors = useCrewRollTheme();
  const content = <View style={styles.content}>{children}</View>;

  if (!scroll) {
    return (
      <View testID={testID} style={[styles.root, { backgroundColor: colors.background }]}>
        {content}
      </View>
    );
  }

  return (
    <ScrollView
      testID={testID}
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.scrollContent}
      contentInsetAdjustmentBehavior="automatic"
    >
      {content}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  content: {
    flex: 1,
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xl,
  },
});
