import {
  TRIP_CREATE_DEFAULT_DURATION_MS,
  TRIP_CREATE_MAX_DURATION_MS,
} from "../../application/trips/tripCreateWindow";
import {
  DateTimePicker as ExpoDateTimePicker,
  type DateTimePickerChangeEvent,
} from "@expo/ui/community/datetime-picker";
import { useState } from "react";
import { Platform, View } from "react-native";

import {
  AppText,
  Button,
  Stack,
  Surface,
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

type AndroidControlsProps = Readonly<{
  value: Date;
  now: Date;
  onChange: (value: Date) => void;
  disabled: boolean;
  locale?: string;
}>;

function AndroidControls({
  disabled,
  locale,
  now,
  onChange,
  value,
}: AndroidControlsProps) {
  const [activePicker, setActivePicker] = useState<PickerMode | null>(null);

  function chooseDate(_event: DateTimePickerChangeEvent, selectedDate: Date) {
    setActivePicker(null);
    onChange(combineAndroidTripEndDate(value, selectedDate));
  }

  function chooseTime(_event: DateTimePickerChangeEvent, selectedTime: Date) {
    setActivePicker(null);
    onChange(combineTripEndTime(value, selectedTime));
  }

  return (
    <Stack gap="sm">
      <Button
        accessibilityHint="Opens the native date picker for the trip end."
        disabled={disabled}
        label="Change end date"
        onPress={() => setActivePicker("date")}
        variant="secondary"
      />
      <Button
        accessibilityHint="Opens the native time picker for the trip end."
        disabled={disabled}
        label="Change end time"
        onPress={() => setActivePicker("time")}
        variant="secondary"
      />
      {!disabled && activePicker === "date" ? (
        <PickerSurface
          {...(locale === undefined ? {} : { locale })}
          mode="date"
          now={now}
          onDismiss={() => setActivePicker(null)}
          onValueChange={chooseDate}
          value={value}
        />
      ) : null}
      {!disabled && activePicker === "time" ? (
        <PickerSurface
          {...(locale === undefined ? {} : { locale })}
          mode="time"
          now={now}
          onDismiss={() => setActivePicker(null)}
          onValueChange={chooseTime}
          value={value}
        />
      ) : null}
    </Stack>
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
  const isAndroid = Platform.OS === "android";
  const displayValue = formatTripEnd(value, locale);

  return (
    <Stack gap="sm">
      <Surface muted>
        <Stack gap="xxs">
          <AppText variant="label">Trip ends</AppText>
          <AppText>{displayValue}</AppText>
          <AppText tone="secondary" variant="caption">
            Choose a future local date and time, up to 14 days from now.
          </AppText>
        </Stack>
      </Surface>

      {isAndroid ? (
        <AndroidControls
          key={disabled ? "disabled" : "enabled"}
          disabled={disabled}
          {...(locale === undefined ? {} : { locale })}
          now={now}
          onChange={onChange}
          value={value}
        />
      ) : (
        <Stack gap="sm">
          <PickerSurface
            disabled={disabled}
            {...(locale === undefined ? {} : { locale })}
            mode="date"
            now={now}
            onValueChange={(_event, selectedDate) =>
              onChange(combineTripEndDate(value, selectedDate))
            }
            value={value}
          />
          <PickerSurface
            disabled={disabled}
            {...(locale === undefined ? {} : { locale })}
            mode="time"
            now={now}
            onValueChange={(_event, selectedTime) =>
              onChange(combineTripEndTime(value, selectedTime))
            }
            value={value}
          />
        </Stack>
      )}

      {errorMessage ? (
        <AppText accessibilityRole="alert" tone="critical" variant="caption">
          {errorMessage}
        </AppText>
      ) : null}
    </Stack>
  );
}
