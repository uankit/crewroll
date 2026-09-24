import { Pressable, View } from "react-native";
import { AppText, spacing, useCrewRollTheme } from "../design-system";

export function AccountMenuRow({
  label,
  onPress,
  critical = false,
  disabled = false,
}: Readonly<{
  label: string;
  onPress(): void;
  critical?: boolean;
  disabled?: boolean;
}>) {
  const theme = useCrewRollTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        paddingVertical: spacing.sm,
        opacity: disabled ? 0.45 : pressed ? 0.65 : 1,
      })}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          gap: spacing.sm,
        }}
      >
        <AppText tone={critical ? "critical" : "primary"}>{label}</AppText>
        <AppText style={{ color: theme.textSecondary }} accessible={false}>
          ›
        </AppText>
      </View>
    </Pressable>
  );
}
