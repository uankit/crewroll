import { useRef, useState } from "react";

import { AppText, Button, FlowScreen, TextField } from "../../design-system";
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
    <FlowScreen
      testID="create-trip-screen"
      label="Create trip"
      title="Name your trip."
      description="Start when you’re ready. Choose when sharing ends."
      {...(submitting ? {} : { onBack: onCancel })}
      footer={
        <>
          <Button
            label="Create trip"
            loading={submitting}
            onPress={createTrip}
          />
          <AppText
            tone="secondary"
            variant="caption"
            style={{ textAlign: "center" }}
          >
            Photo access comes next.
          </AppText>
        </>
      }
    >
      <TextField
        {...(nameError === undefined ? {} : { errorMessage: nameError })}
        accessibilityHint="Enter a name of 80 characters or fewer."
        autoCapitalize="sentences"
        disabled={submitting}
        label="Trip name"
        placeholder="Goa weekend"
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
        title="Checking your trip."
        description="Your trip may already be created. Check the same request to continue."
        footer={
          <Button
            label="Check trip status"
            loading={state.checking ?? false}
            onPress={state.onCheck}
          />
        }
      />
    );
  return <CreateTripForm {...props} submitting={state.kind === "submitting"} />;
}
