import {
  TRIP_CREATE_DEFAULT_DURATION_MS,
  TRIP_CREATE_MAX_DURATION_MS,
} from "../../application/trips/tripCreateWindow";
import {
  DateTimePicker as ExpoDateTimePicker,
  type DateTimePickerChangeEvent,
} from "@expo/ui/community/datetime-picker";
import { useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";

import {
  AppText,
  Button,
  Stack,
  Sheet,
  spacing,
  radius,
  useCrewRollTheme,
} from "../../design-system";

export type TripEndFieldProps = Readonly<{
  value: Date;
  now: Date;
  onChange: (value: Date) => void;
  disabled?: boolean;
  errorMessage?: string;
  locale?: string;
}>;

export function createDefaultTripEnd(now: Date): Date {
  return new Date(now.getTime() + TRIP_CREATE_DEFAULT_DURATION_MS);
}

export function tripEndValidationMessage(
  value: Date,
  now: Date,
): string | undefined {
  const valueTime = value.getTime();
  const nowTime = now.getTime();

  if (!Number.isFinite(valueTime) || valueTime <= nowTime) {
    return "Choose a valid future end time.";
  }

  if (valueTime > nowTime + TRIP_CREATE_MAX_DURATION_MS) {
    return "Trips can last up to 14 days. Choose an earlier end time.";
  }

  return undefined;
}

export function combineTripEndDate(current: Date, selectedDate: Date): Date {
  return new Date(
    selectedDate.getFullYear(),
    selectedDate.getMonth(),
    selectedDate.getDate(),
    current.getHours(),
    current.getMinutes(),
    current.getSeconds(),
    current.getMilliseconds(),
  );
}

function androidDatePickerValue(value: Date): Date {
  // Expo's Android Material date picker represents calendar days at UTC midnight.
  return new Date(
    Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()),
  );
}

function combineAndroidTripEndDate(current: Date, selectedUtcDate: Date): Date {
  // Recover the selected calendar fields before restoring the user's local time.
  return new Date(
    selectedUtcDate.getUTCFullYear(),
    selectedUtcDate.getUTCMonth(),
    selectedUtcDate.getUTCDate(),
    current.getHours(),
    current.getMinutes(),
    current.getSeconds(),
    current.getMilliseconds(),
  );
}

export function combineTripEndTime(current: Date, selectedTime: Date): Date {
  return new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
    selectedTime.getHours(),
    selectedTime.getMinutes(),
    0,
    0,
  );
}

type PickerMode = "date" | "time";

type PickerSurfaceProps = Readonly<{
  mode: PickerMode;
  value: Date;
  now: Date;
  onDismiss?: () => void;
  onValueChange: (event: DateTimePickerChangeEvent, value: Date) => void;
  disabled?: boolean;
  locale?: string;
}>;

function PickerSurface({
  disabled,
  locale,
  mode,
  now,
  onDismiss,
  onValueChange,
  value,
}: PickerSurfaceProps) {
  const theme = useCrewRollTheme();
  const isAndroid = Platform.OS === "android";
  const pickerValue =
    isAndroid && mode === "date" ? androidDatePickerValue(value) : value;
  const pickerProps = {
    accentColor: theme.action,
    maximumDate: new Date(now.getTime() + TRIP_CREATE_MAX_DURATION_MS),
    minimumDate: now,
    mode,
    onValueChange,
    value: pickerValue,
    ...(isAndroid
      ? {
          ...(onDismiss === undefined ? {} : { onDismiss }),
          presentation: "dialog" as const,
        }
      : {
          disabled: disabled ?? false,
          ...(locale === undefined ? {} : { locale }),
          themeVariant: theme.scheme,
        }),
  };

  return (
    <View testID={`trip-end-${mode}-picker`}>
      <ExpoDateTimePicker {...pickerProps} />
    </View>
  );
}

export function TripEndField({
  disabled = false,
  errorMessage,
  locale,
  now,
  onChange,
  value,
}: TripEndFieldProps) {
  const theme = useCrewRollTheme();
  const { width, fontScale } = useWindowDimensions();
  const [mode, setMode] = useState<PickerMode | null>(null);
  if (disabled && mode) setMode(null);
  const rowLayout = width >= 360 && fontScale <= 1.2;
  const valid = Number.isFinite(value.getTime());
  const labels = {
    date: valid
      ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(value)
      : "Choose date",
    time: valid
      ? new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(value)
      : "Choose time",
  };
  const picker = mode ? (
    <PickerSurface
      mode={mode}
      now={now}
      value={value}
      {...(locale ? { locale } : {})}
      onDismiss={() => setMode(null)}
      onValueChange={(_event, selected) => {
        if (disabled) return;
        onChange(
          mode === "time"
            ? combineTripEndTime(value, selected)
            : Platform.OS === "android"
              ? combineAndroidTripEndDate(value, selected)
              : combineTripEndDate(value, selected),
        );
        if (Platform.OS === "android") setMode(null);
      }}
    />
  ) : null;
  return (
    <Stack gap="xs">
      <View
        style={{ flexDirection: rowLayout ? "row" : "column", gap: spacing.sm }}
      >
        {(["date", "time"] as const).map((field) => (
          <View
            key={field}
            style={{
              flex: rowLayout ? (field === "date" ? 1.35 : 1) : undefined,
              gap: spacing.xs,
            }}
          >
            <AppText variant="label">
              {field === "date" ? "End date" : "End time"}
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`End ${field}. ${labels[field]}`}
              accessibilityHint={`Choose the ${field} sharing stops.`}
              disabled={disabled}
              onPress={() => setMode(field)}
              style={[
                styles.field,
                {
                  backgroundColor: theme.surface,
                  borderColor: errorMessage
                    ? theme.critical
                    : theme.textSecondary,
                },
              ]}
            >
              <AppText>{labels[field]}</AppText>
            </Pressable>
          </View>
        ))}
      </View>
      {mode && Platform.OS === "android" ? picker : null}
      {Platform.OS === "ios" ? (
        <Sheet
          visible={mode !== null}
          title={mode === "time" ? "End time" : "End date"}
          onDismiss={() => setMode(null)}
        >
          {picker}
          <Button label="Done" onPress={() => setMode(null)} />
        </Sheet>
      ) : null}
      {errorMessage ? (
        <AppText accessibilityRole="alert" tone="critical" variant="caption">
          {errorMessage}
        </AppText>
      ) : null}
    </Stack>
  );
}
const styles = StyleSheet.create({
  field: {
    minHeight: 56,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
});
