import type { PropsWithChildren } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

export type ScreenProps = PropsWithChildren<{
  readonly scroll?: boolean;
  readonly testID?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly contentStyle?: StyleProp<ViewStyle>;
  readonly keyboardShouldPersistTaps?: ScrollViewProps["keyboardShouldPersistTaps"];
}>;

export function Screen({
  children,
  scroll = true,
  testID,
  style,
  contentStyle,
  keyboardShouldPersistTaps = "handled",
}: ScreenProps) {
  const colors = useCrewRollTheme();
  const content = (
    <View style={[styles.content, contentStyle]}>{children}</View>
  );

  if (!scroll) {
    return (
      <SafeAreaView
        edges={["top", "bottom"]}
        testID={testID}
        style={[styles.root, { backgroundColor: colors.background }, style]}
      >
        {content}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      edges={["top", "bottom"]}
      testID={testID}
      style={[styles.root, { backgroundColor: colors.background }, style]}
    >
      <KeyboardAvoidingView
        enabled={Platform.OS === "android"}
        behavior="height"
        style={styles.root}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        >
          {content}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
    width: "100%",
    maxWidth: 520,
    alignSelf: "center",
  },
});
