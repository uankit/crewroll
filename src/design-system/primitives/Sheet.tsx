import type { PropsWithChildren } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { AppText } from "./AppText";
import { IconButton } from "./IconButton";
import { Inline } from "./Inline";
import { Stack } from "./Stack";

export type SheetProps = PropsWithChildren<{
  readonly visible: boolean;
  readonly title: string;
  readonly onDismiss: () => void;
  readonly closeLabel?: string;
  readonly dismissOnBackdropPress?: boolean;
  readonly contentStyle?: StyleProp<ViewStyle>;
  readonly testID?: string;
}>;

export function Sheet({
  children,
  visible,
  title,
  onDismiss,
  closeLabel,
  dismissOnBackdropPress = true,
  contentStyle,
  testID = "sheet-modal",
}: SheetProps) {
  const theme = useCrewRollTheme();
  const resolvedCloseLabel = closeLabel ?? `Close ${title}`;

  return (
    <Modal
      animationType={theme.motion.navigation === 0 ? "none" : "slide"}
      onRequestClose={onDismiss}
      statusBarTranslucent
      testID={testID}
      transparent
      visible={visible}
    >
      <View style={styles.root}>
        <Pressable
          accessible={false}
          disabled={!dismissOnBackdropPress}
          importantForAccessibility="no-hide-descendants"
          onPress={onDismiss}
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: theme.background, opacity: 0.72 },
          ]}
        />
        <Stack
          accessibilityViewIsModal
          gap="lg"
          onAccessibilityEscape={onDismiss}
          style={[
            styles.content,
            {
              backgroundColor: theme.surface,
              borderColor: theme.border,
            },
            contentStyle,
          ]}
          testID="sheet-content"
        >
          <Inline align="start" justify="space-between">
            <AppText
              accessibilityRole="header"
              style={styles.title}
              variant="title2"
            >
              {title}
            </AppText>
            <IconButton
              icon={
                <AppText aria-hidden tone="secondary" variant="title2">
                  ×
                </AppText>
              }
              label={resolvedCloseLabel}
              onPress={onDismiss}
            />
          </Inline>
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            style={styles.scrollBody}
            testID="sheet-scroll-body"
          >
            {children}
          </ScrollView>
        </Stack>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "flex-end",
  },
  content: {
    borderTopEndRadius: radius.xl,
    borderTopStartRadius: radius.xl,
    borderWidth: 1,
    maxHeight: "90%",
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.gutter,
  },
  title: {
    flex: 1,
  },
  scrollBody: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scrollContent: {
    gap: spacing.lg,
  },
});
