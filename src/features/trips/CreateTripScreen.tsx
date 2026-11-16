import { useRef, useState, type ReactNode } from "react";
import { Keyboard } from "react-native";

import {
  Button,
  AppText,
  CrewRollHeader,
  FlowScreen,
  Stack,
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
    }>;

export type CreateTripInput = Readonly<{
  name: string;
  endsAt: string;
}>;

export type CreateTripScreenProps = Readonly<{
  accountControl?: ReactNode;
  now: Date;
  onCancel: () => void;
  onCreate: (input: CreateTripInput) => void;
  onDraftChange?: (input: CreateTripInput) => void;
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

function CreateTripForm({
  accountControl,
  initialEndsAt,
  initialName = "",
  locale,
  now,
  onCancel,
  onCreate,
  onDraftChange,
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
    Keyboard.dismiss();
    onCreate({ endsAt: endsAt.toISOString(), name: trimmedName });
  }

  return (
    <FlowScreen
      testID="create-trip-screen"
      pinnedHeader
      pinnedFooter
      header={
        <CrewRollHeader accountControl={accountControl}>
          {!submitting ? (
            <Button
              label="‹ Back"
              accessibilityLabel="Back"
              variant="text"
              onPress={onCancel}
              style={{ alignSelf: "flex-start" }}
            />
          ) : null}
        </CrewRollHeader>
      }
      title="Name your trip."
      description="Start when you’re ready. Choose when sharing ends."
      footer={
        <Button label="Create trip" loading={submitting} onPress={createTrip} />
      }
    >
      <TextField
        {...(nameError === undefined ? {} : { errorMessage: nameError })}
        accessibilityHint="Enter a name of 80 characters or fewer."
        autoCapitalize="sentences"
        disabled={submitting}
        label="Trip name"
        placeholder="Goa weekend"
        returnKeyType="done"
        onSubmitEditing={Keyboard.dismiss}
        onChangeText={(value) => {
          createRequested.current = false;
          setName(value);
          onDraftChange?.({ name: value, endsAt: endsAt.toISOString() });
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
          onDraftChange?.({ name, endsAt: value.toISOString() });
          setAttempted(false);
        }}
        value={endsAt}
      />
    </FlowScreen>
  );
}

export function CreateTripScreen({
  state = { kind: "editing" },
  ...props
}: CreateTripScreenProps) {
  if (state.kind === "unknown")
    return (
      <FlowScreen
        testID="create-trip-screen"
        header={<CrewRollHeader accountControl={props.accountControl} />}
        pinnedHeader
        centerContent
      >
        <Stack gap="md">
          <AppText
            accessibilityRole="header"
            variant="title1"
            style={{ textAlign: "center" }}
          >
            Checking your trip.
          </AppText>
          <AppText tone="secondary" style={{ textAlign: "center" }}>
            Your trip may already be created. Check its status to continue.
          </AppText>
          <Button
            label="Check trip status"
            loading={state.checking ?? false}
            onPress={state.onCheck}
          />
        </Stack>
      </FlowScreen>
    );
  return <CreateTripForm {...props} submitting={state.kind === "submitting"} />;
}
