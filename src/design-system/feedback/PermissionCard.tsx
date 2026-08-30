import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { AppText, Button, Stack, Surface } from "../primitives";
import { StatusBadge } from "./StatusBadge";
import {
  feedbackActionButtonProps,
  type FeedbackAction,
  type FeedbackStatus,
} from "./types";

export type PermissionReadiness =
  | Readonly<{
      detail: string;
      kind: "READY";
      label: string;
    }>
  | Readonly<{
      action: FeedbackAction;
      detail: string;
      kind: "REQUEST_ACCESS";
      label: string;
    }>
  | Readonly<{
      action: FeedbackAction;
      detail: string;
      kind: "OPEN_SETTINGS";
      label: string;
    }>;

type PermissionReadinessKind = PermissionReadiness["kind"];

const readinessStatus = {
  OPEN_SETTINGS: { icon: "!", tone: "warning" },
  READY: { icon: "✓", tone: "success" },
  REQUEST_ACCESS: { icon: "○", tone: "info" },
} as const satisfies Record<
  PermissionReadinessKind,
  Pick<FeedbackStatus, "icon" | "tone">
>;

export type PermissionCardProps = {
  readonly readiness: PermissionReadiness;
  readonly title: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function PermissionCard({
  readiness,
  title,
  style,
  testID = `permission-card-${readiness.kind}`,
}: PermissionCardProps) {
  const status = readinessStatus[readiness.kind];
  const action = readiness.kind === "READY" ? undefined : readiness.action;

  return (
    <Surface style={[styles.root, style]} testID={testID}>
      <Stack gap="sm">
        <AppText variant="headline">{title}</AppText>
        <StatusBadge
          icon={status.icon}
          label={readiness.label}
          tone={status.tone}
        />
        <AppText tone="secondary">{readiness.detail}</AppText>
        {action ? (
          <Button {...feedbackActionButtonProps(action)} variant="secondary" />
        ) : null}
      </Stack>
    </Surface>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "stretch",
  },
});
