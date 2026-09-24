import { StyleSheet, View } from "react-native";
import {
  AppIcon,
  AppText,
  IconButton,
  MemberAvatar,
  spacing,
  useCrewRollTheme,
} from "../../design-system";

export function JoinRequestRow({
  name,
  description,
  busy,
  disabled,
  onApprove,
  onDecline,
}: Readonly<{
  name: string;
  description?: string;
  busy: "approve" | "decline" | null;
  disabled: boolean;
  onApprove: () => void;
  onDecline: () => void;
}>) {
  const theme = useCrewRollTheme();
  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <MemberAvatar displayName={name} muted />
      <View style={styles.identity}>
        <AppText variant="bodyStrong">{name}</AppText>
        {description ? (
          <AppText variant="caption" tone="secondary">
            {description}
          </AppText>
        ) : null}
      </View>
      <View style={styles.actions}>
        <IconButton
          label={`Decline ${name}`}
          icon={<AppIcon name="close" color={theme.textSecondary} size={20} />}
          disabled={disabled}
          loading={busy === "decline"}
          onPress={onDecline}
        />
        <IconButton
          label={`Approve ${name}`}
          icon={<AppIcon name="check" color={theme.success} size={20} />}
          disabled={disabled}
          loading={busy === "approve"}
          onPress={onApprove}
          style={{
            backgroundColor: theme.successSurface,
            borderColor: theme.successSurface,
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  identity: { flex: 1, minWidth: 0, gap: spacing.xxs },
  actions: { flexDirection: "row", gap: spacing.xs },
});
