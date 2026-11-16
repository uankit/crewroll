import {
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from "react";
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

export type ScrollRestoration = Readonly<{
  key: string;
  offsetY: number;
  onChange(offsetY: number): void;
}>;

export type ScreenProps = PropsWithChildren<{
  readonly fixedHeader?: ReactNode;
  readonly fixedFooter?: ReactNode;
  readonly scroll?: boolean;
  readonly testID?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly contentStyle?: StyleProp<ViewStyle>;
  readonly keyboardShouldPersistTaps?: ScrollViewProps["keyboardShouldPersistTaps"];
  readonly scrollRestoration?: ScrollRestoration;
}>;

function RestorableScrollView({
  restoration,
  ...props
}: ScrollViewProps & {
  restoration?: ScrollRestoration;
}) {
  const scroll = useRef<ScrollView>(null);
  const [initialOffset] = useState(restoration?.offsetY ?? 0);
  const restored = useRef(initialOffset === 0);
  return (
    <ScrollView
      {...props}
      ref={scroll}
      contentOffset={{ x: 0, y: initialOffset }}
      scrollEventThrottle={16}
      onContentSizeChange={(_, height) => {
        if (!restored.current && height > 0) {
          restored.current = true;
          scroll.current?.scrollTo({
            y: initialOffset,
            animated: false,
          });
        }
      }}
      onScrollBeginDrag={() => {
        restored.current = true;
      }}
      onScroll={(event) => {
        if (restored.current)
          restoration?.onChange(event.nativeEvent.contentOffset.y);
      }}
    />
  );
}

export function Screen({
  children,
  fixedHeader,
  fixedFooter,
  scroll = true,
  testID,
  style,
  contentStyle,
  keyboardShouldPersistTaps = "handled",
  scrollRestoration,
}: ScreenProps) {
  const colors = useCrewRollTheme();
  const content = (
    <View style={[styles.content, contentStyle]}>{children}</View>
  );
  const header = fixedHeader ? (
    <View style={styles.fixedHeader}>{fixedHeader}</View>
  ) : null;
  const footer = fixedFooter ? (
    <View style={styles.fixedFooter}>{fixedFooter}</View>
  ) : null;
  const body = scroll ? (
    <RestorableScrollView
      key={scrollRestoration?.key ?? "screen"}
      {...(testID ? { testID: `${testID}-scroll` } : {})}
      {...(scrollRestoration ? { restoration: scrollRestoration } : {})}
      style={styles.root}
      contentContainerStyle={styles.scrollContent}
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets={false}
      keyboardDismissMode="on-drag"
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
    >
      {content}
    </RestorableScrollView>
  ) : (
    content
  );
  const keyboardContent =
    scroll || footer ? (
      <KeyboardAvoidingView
        {...(testID ? { testID: `${testID}-keyboard-area` } : {})}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.root}
      >
        {body}
        {footer}
      </KeyboardAvoidingView>
    ) : (
      body
    );

  return (
    <SafeAreaView
      edges={["top", "bottom"]}
      testID={testID}
      style={[styles.root, { backgroundColor: colors.background }, style]}
    >
      {header}
      {keyboardContent}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fixedHeader: {
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    width: "100%",
    maxWidth: 520,
    alignSelf: "center",
  },
  fixedFooter: {
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    width: "100%",
    maxWidth: 520,
    alignSelf: "center",
    flexShrink: 0,
  },
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
