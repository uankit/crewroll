import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { AppText, PressableRow, Stack } from "../primitives";
import { spacing } from "../tokens/spacing";

export type ReleaseMode = "IMMEDIATE" | "NIGHTLY";

export type ReleaseModeFieldProps = {
  readonly disabled?: boolean;
  readonly immediateDescription: string;
  readonly label: string;
  readonly nightlyDescription: string;
  readonly nightlyDisabled?: boolean;
  readonly onChange: (mode: ReleaseMode) => void;
  readonly value: ReleaseMode;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

export function ReleaseModeField({
  disabled = false,
  immediateDescription,
  label,
  nightlyDescription,
  nightlyDisabled = false,
  onChange,
  value,
  style,
  testID,
}: ReleaseModeFieldProps) {
  return (
    <Stack
      accessibilityLabel={label}
      accessibilityRole="radiogroup"
      gap="sm"
      style={style}
      testID={testID}
    >
      <AppText variant="label">{label}</AppText>
      <PressableRow
        checked={value === "IMMEDIATE"}
        disabled={disabled}
        label="Immediate"
        onPress={() => onChange("IMMEDIATE")}
        role="radio"
        style={styles.option}
        supportingText={immediateDescription}
      />
      <PressableRow
        checked={value === "NIGHTLY"}
        disabled={disabled || nightlyDisabled}
        label="Nightly"
        onPress={() => onChange("NIGHTLY")}
        role="radio"
        style={styles.option}
        supportingText={nightlyDescription}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({
  option: {
    minWidth: spacing.xxxl,
  },
});
