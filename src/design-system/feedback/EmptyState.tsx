import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { AppText, Button, Stack, Surface } from "../primitives";
import { feedbackActionButtonProps, type FeedbackAction } from "./types";

export type EmptyStateProps = {
  readonly action?: FeedbackAction;
  readonly body: string;
  readonly icon: string;
  readonly title: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function EmptyState({
  action,
  body,
  icon,
  title,
  style,
  testID,
}: EmptyStateProps) {
  return (
    <Surface style={[styles.root, style]} testID={testID}>
      <Stack align="center" gap="sm">
        <AppText aria-hidden variant="title2">
          {icon}
        </AppText>
        <AppText style={styles.copy} variant="headline">
          {title}
        </AppText>
        <AppText style={styles.copy} tone="secondary">
          {body}
        </AppText>
        {action ? <Button {...feedbackActionButtonProps(action)} /> : null}
      </Stack>
    </Surface>
  );
}

const styles = StyleSheet.create({
  copy: {
    textAlign: "center",
  },
  root: {
    alignItems: "stretch",
  },
});
