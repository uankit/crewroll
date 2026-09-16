import { forwardRef, useId } from "react";
import {
  StyleSheet,
  TextInput,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import { radius } from "../tokens/radius";
import { spacing } from "../tokens/spacing";
import { typography } from "../tokens/typography";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";
import { AppText } from "./AppText";
import { Stack } from "./Stack";

export type TextFieldProps = Omit<
  TextInputProps,
  "editable" | "readOnly" | "style"
> & {
  readonly label: string;
  readonly supportingText?: string;
  readonly errorMessage?: string;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly containerStyle?: StyleProp<ViewStyle>;
  readonly inputStyle?: StyleProp<TextStyle>;
};

export const TextField = forwardRef<TextInput, TextFieldProps>(
  function TextField(
    {
      label,
      supportingText,
      errorMessage,
      disabled = false,
      readOnly = false,
      containerStyle,
      inputStyle,
      accessibilityHint,
      accessibilityLabel,
      accessibilityState,
      allowFontScaling = true,
      maxFontSizeMultiplier = 2,
      placeholderTextColor,
      ...props
    },
    ref,
  ) {
    const colors = useCrewRollTheme();
    const generatedId = useId();
    const labelId = `${generatedId}-label`;
    const supportingId = `${generatedId}-supporting`;
    const errorId = `${generatedId}-error`;
    const descriptionIds = [
      supportingText ? supportingId : undefined,
      errorMessage ? errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(" ");

    return (
      <Stack gap="xs" style={containerStyle}>
        <AppText nativeID={labelId} variant="label">
          {label}
        </AppText>
        <TextInput
          {...props}
          ref={ref}
          accessibilityHint={
            accessibilityHint ?? errorMessage ?? supportingText
          }
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityLabelledBy={labelId}
          accessibilityState={{ ...accessibilityState, disabled }}
          allowFontScaling={allowFontScaling}
          aria-describedby={descriptionIds || undefined}
          aria-invalid={Boolean(errorMessage)}
          editable={!disabled && !readOnly}
          maxFontSizeMultiplier={maxFontSizeMultiplier}
          placeholderTextColor={placeholderTextColor ?? colors.textSecondary}
          selectionColor={colors.action}
          style={[
            styles.input,
            typography.body,
            {
              backgroundColor: disabled ? colors.surfaceMuted : colors.surface,
              borderColor: errorMessage
                ? colors.critical
                : colors.textSecondary,
              color: colors.textPrimary,
            },
            inputStyle,
          ]}
        />
        {supportingText ? (
          <AppText nativeID={supportingId} tone="secondary" variant="caption">
            {supportingText}
          </AppText>
        ) : null}
        {errorMessage ? (
          <AppText
            accessibilityRole="alert"
            nativeID={errorId}
            tone="critical"
            variant="caption"
          >
            {errorMessage}
          </AppText>
        ) : null}
      </Stack>
    );
  },
);

const styles = StyleSheet.create({
  input: {
    borderRadius: radius.md,
    borderWidth: 1,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
});
