import { useState } from "react";
import { Linking, StyleSheet } from "react-native";
import {
  AppText,
  Button,
  FlowScreen,
  Stack,
  useCrewRollTheme,
} from "../../design-system";

export function TermsScreen({
  busy,
  error,
  onAccept,
  onRetry,
  onBack,
}: Readonly<{
  busy: boolean;
  error: string | null;
  onAccept(): void;
  onRetry(): void;
  onBack(): void;
}>) {
  const theme = useCrewRollTheme();
  const [linkError, setLinkError] = useState(false);
  const open = (path: string) => {
    setLinkError(false);
    void Linking.openURL(`https://crewroll.app/${path}`).catch(() =>
      setLinkError(true),
    );
  };
  // An unavailable account is its own state. Never mix a consent CTA with an
  // error or imply consent was saved when the request could not be confirmed.
  if (error || linkError)
    return (
      <FlowScreen
        label="Before you share"
        onBack={onBack}
        centerContent
        footer={
          <Button
            label="Try again"
            onPress={() => {
              setLinkError(false);
              onRetry();
            }}
          />
        }
      >
        <Stack gap="md" style={styles.content}>
          <AppText
            accessibilityRole="header"
            variant="title1"
            style={styles.title}
          >
            Let’s try again.
          </AppText>
          <AppText accessibilityRole="alert" tone="secondary">
            {linkError
              ? "The page couldn’t open. Check your connection and try again."
              : error}
          </AppText>
        </Stack>
      </FlowScreen>
    );
  return (
    <FlowScreen
      label="Before you share"
      onBack={onBack}
      centerContent
      footer={
        <Button label="Agree & continue" loading={busy} onPress={onAccept} />
      }
    >
      <Stack gap="md" style={styles.content}>
        <AppText
          accessibilityRole="header"
          variant="title1"
          style={styles.title}
        >
          Share with care.
        </AppText>
        <AppText tone="secondary">
          Share photos you have permission to share. Keep harmful and illegal
          content out of your crew.
        </AppText>
        <AppText variant="caption" tone="secondary">
          By continuing, you accept our{" "}
          <AppText
            variant="caption"
            accessibilityRole="link"
            onPress={() => open("terms")}
            style={{ color: theme.action, textDecorationLine: "underline" }}
          >
            Terms
          </AppText>{" "}
          and acknowledge our{" "}
          <AppText
            variant="caption"
            accessibilityRole="link"
            onPress={() => open("privacy")}
            style={{ color: theme.action, textDecorationLine: "underline" }}
          >
            Privacy Policy
          </AppText>
          .
        </AppText>
      </Stack>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  content: { width: "100%", maxWidth: 380, alignSelf: "center" },
  title: { fontSize: 28, lineHeight: 36 },
});
