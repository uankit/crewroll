import { useRef, useState } from "react";

import {
  AppText,
  Button,
  InlineBanner,
  Screen,
  Stack,
  StatusBadge,
  Surface,
  TextField,
} from "../../design-system";
import {
  createDefaultTripEnd,
  TripEndField,
  tripEndValidationMessage,
} from "./TripEndField";

export type CreateTripScreenState =
  | Readonly<{ kind: "editing" }>
  | Readonly<{ kind: "submitting" }>
  | Readonly<{
      kind: "unknown";
      onCheck: () => void;
      checking?: boolean;
    }>
  | Readonly<{
      kind: "success";
      onOpenTrip: () => void;
    }>;

export type CreateTripInput = Readonly<{
  name: string;
  endsAt: string;
}>;

export type CreateTripScreenProps = Readonly<{
  now: Date;
  onCancel: () => void;
  onCreate: (input: CreateTripInput) => void;
  initialName?: string;
  initialEndsAt?: Date;
  locale?: string;
  state?: CreateTripScreenState;
}>;

const missingNameMessage = "Enter a trip name.";
const longNameMessage = "Keep the trip name to 80 characters or fewer.";

function tripNameValidationMessage(value: string): string | undefined {
  if (value.length === 0) return missingNameMessage;
  if (Array.from(value).length > 80) return longNameMessage;
  return undefined;
}

type CreateTripFormProps = Omit<CreateTripScreenProps, "state"> &
  Readonly<{ submitting: boolean }>;

function ImmediateReleaseExplanation() {
  return (
    <Surface muted>
      <Stack gap="xs">
        <StatusBadge icon="✓" label="Immediate release" tone="info" />
        <AppText tone="secondary">
          Eligible photos can arrive automatically after the owner starts the
          trip.
        </AppText>
      </Stack>
    </Surface>
  );
}

function CreateTripForm({
  initialEndsAt,
  initialName = "",
  locale,
  now,
  onCancel,
  onCreate,
  submitting,
}: CreateTripFormProps) {
  const [name, setName] = useState(initialName);
  const [endsAt, setEndsAt] = useState(
    () => initialEndsAt ?? createDefaultTripEnd(now),
  );
  const [attempted, setAttempted] = useState(false);
  const createRequested = useRef(false);
  const trimmedName = name.trim();
  const nameError = attempted
    ? tripNameValidationMessage(trimmedName)
    : undefined;
  const endError = attempted
    ? tripEndValidationMessage(endsAt, now)
    : undefined;

  function createTrip() {
    if (submitting || createRequested.current) return;

    const nextNameError = tripNameValidationMessage(trimmedName);
    const nextEndError = tripEndValidationMessage(endsAt, now);
    setAttempted(true);
    if (nextNameError !== undefined || nextEndError !== undefined) return;

    createRequested.current = true;
    onCreate({ endsAt: endsAt.toISOString(), name: trimmedName });
  }

  return (
    <Screen keyboardShouldPersistTaps="handled" testID="create-trip-screen">
      <Stack gap="xl">
        <Stack gap="sm">
          <AppText tone="action" variant="eyebrow">
            New trip
          </AppText>
          <AppText accessibilityRole="header" variant="display">
            Create an Immediate trip
          </AppText>
          <AppText tone="secondary">
            Name your trip and choose when automatic delivery should stop.
          </AppText>
        </Stack>

        <TextField
          {...(nameError === undefined ? {} : { errorMessage: nameError })}
          accessibilityHint="Enter a name of 80 characters or fewer."
          autoCapitalize="sentences"
          disabled={submitting}
          label="Trip name"
          onChangeText={(value) => {
            createRequested.current = false;
            setName(value);
            setAttempted(false);
          }}
          value={name}
        />

        <TripEndField
          {...(endError === undefined ? {} : { errorMessage: endError })}
          disabled={submitting}
          {...(locale === undefined ? {} : { locale })}
          now={now}
          onChange={(value) => {
            createRequested.current = false;
            setEndsAt(value);
            setAttempted(false);
          }}
          value={endsAt}
        />

        <ImmediateReleaseExplanation />

        <Stack gap="sm">
          <Button
            accessibilityHint="Creates this Immediate trip once."
            label="Create trip"
            loading={submitting}
            onPress={createTrip}
          />
          <Button
            accessibilityHint="Returns without creating a trip."
            disabled={submitting}
            label="Cancel"
            onPress={onCancel}
            variant="secondary"
          />
        </Stack>
      </Stack>
    </Screen>
  );
}

function UnknownCreateResult({
  checking = false,
  onCheck,
}: Extract<CreateTripScreenState, { kind: "unknown" }>) {
  return (
    <Screen testID="create-trip-screen">
      <Stack gap="xl">
        <Stack gap="sm">
          <AppText tone="action" variant="eyebrow">
            Create recovery
          </AppText>
          <AppText accessibilityRole="header" variant="display">
            Checking your new trip
          </AppText>
          <StatusBadge icon="…" label="Checking safely" tone="info" />
          <AppText tone="secondary">
            CrewRoll is checking whether your trip was created. Keep this phone
            connected and check again.
          </AppText>
        </Stack>
        <Button
          accessibilityHint="Safely checks the original request without creating another trip."
          label="Check trip status"
          loading={checking}
          onPress={onCheck}
        />
      </Stack>
    </Screen>
  );
}

function CreateSuccessResult({
  onOpenTrip,
}: Extract<CreateTripScreenState, { kind: "success" }>) {
  return (
    <Screen testID="create-trip-screen">
      <Stack gap="xl">
        <Stack gap="sm">
          <AppText tone="action" variant="eyebrow">
            Immediate trip
          </AppText>
          <AppText accessibilityRole="header" variant="display">
            Trip created
          </AppText>
          <InlineBanner
            body="Your Immediate trip is ready for its crew."
            icon="✓"
            title="Ready to invite"
            tone="success"
          />
        </Stack>
        <Button
          accessibilityHint="Opens the new trip lobby."
          label="Open trip"
          onPress={onOpenTrip}
        />
      </Stack>
    </Screen>
  );
}

export function CreateTripScreen({
  state = { kind: "editing" },
  ...props
}: CreateTripScreenProps) {
  if (state.kind === "unknown") {
    return <UnknownCreateResult {...state} />;
  }

  if (state.kind === "success") {
    return <CreateSuccessResult {...state} />;
  }

  return <CreateTripForm {...props} submitting={state.kind === "submitting"} />;
}
