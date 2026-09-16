import {
  TRIP_CREATE_DEFAULT_DURATION_MS,
  TRIP_CREATE_MAX_DURATION_MS,
} from "../../application/trips/tripCreateWindow";
import {
  DateTimePicker as ExpoDateTimePicker,
  type DateTimePickerChangeEvent,
} from "@expo/ui/community/datetime-picker";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

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

function formatTripEnd(value: Date, locale: string | undefined): string {
  if (!Number.isFinite(value.getTime())) return "End time unavailable";

  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(value);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(value);
  }
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
      <AppText variant="label">
        {mode === "date" ? "End date" : "End time"}
      </AppText>
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
  const [open, setOpen] = useState(false);
  const displayValue = formatTripEnd(value, locale);
  if (disabled && open) setOpen(false);
  const dateRange = Number.isFinite(value.getTime())
    ? `${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(now)} – ${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(value)}`
    : "Choose trip dates";
  const picker = (
    <PickerSurface
      mode="date"
      now={now}
      value={value}
      {...(locale ? { locale } : {})}
      onDismiss={() => setOpen(false)}
      onValueChange={(_event, selected) => {
        if (disabled) return;
        onChange(
          Platform.OS === "android"
            ? combineAndroidTripEndDate(value, selected)
            : combineTripEndDate(value, selected),
        );
        if (Platform.OS === "android") setOpen(false);
      }}
    />
  );
  return (
    <Stack gap="xs">
      <AppText variant="label">Trip dates</AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Trip dates. Ends ${displayValue}`}
        accessibilityHint="Choose the last day of your trip. Sharing begins when the host starts it."
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={[
          styles.field,
          {
            backgroundColor: theme.surface,
            borderColor: errorMessage ? theme.critical : theme.textSecondary,
          },
        ]}
      >
        <AppText>{dateRange}</AppText>
      </Pressable>
      {open && Platform.OS === "android" ? picker : null}
      {Platform.OS === "ios" ? (
        <Sheet
          visible={open}
          title="Trip dates"
          onDismiss={() => setOpen(false)}
        >
          {picker}
          <Button label="Done" onPress={() => setOpen(false)} />
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
