import { useState } from "react";

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

export type JoinTripScreenState =
  | Readonly<{ kind: "editing" }>
  | Readonly<{ kind: "submitting" }>
  | Readonly<{ kind: "pending"; onOpenTrip: () => void }>
  | Readonly<{
      kind: "invalid";
      onUseAnotherCode: () => void;
    }>
  | Readonly<{
      kind: "rejected";
      onUseAnotherCode: () => void;
    }>
  | Readonly<{
      kind: "failed";
      onRetry: () => void;
      retrying?: boolean;
    }>
  | Readonly<{
      kind: "unknown";
      onRetry: () => void;
      retrying?: boolean;
    }>;

export type JoinTripScreenProps = Readonly<{
  initialCode?: string;
  onCancel: () => void;
  onJoin: (inviteCode: string) => void;
  state?: JoinTripScreenState;
}>;

const inviteCodePattern = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const invalidLocalCode = "Enter the complete 8-character invite code.";

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

type ResultState = Exclude<
  JoinTripScreenState,
  { kind: "editing" | "submitting" }
>;

function ResultScreen({ state }: { readonly state: ResultState }) {
  if (state.kind === "pending") {
    return (
      <Screen testID="join-trip-screen">
        <Stack gap="xl">
          <Stack gap="sm">
            <AppText tone="action" variant="eyebrow">
              Join request
            </AppText>
            <AppText accessibilityRole="header" variant="display">
              Waiting for the owner
            </AppText>
            <StatusBadge icon="…" label="Waiting for approval" tone="warning" />
            <AppText tone="secondary">
              Your request is in. You can join once the owner approves this
              phone.
            </AppText>
          </Stack>
          <Button
            accessibilityHint="Opens the trip lobby to check your request."
            label="Open trip lobby"
            onPress={state.onOpenTrip}
          />
        </Stack>
      </Screen>
    );
  }

  if (state.kind === "invalid" || state.kind === "rejected") {
    const invalid = state.kind === "invalid";
    return (
      <Screen testID="join-trip-screen">
        <Stack gap="xl">
          <Stack gap="sm">
            <AppText tone="action" variant="eyebrow">
              Join a trip
            </AppText>
            <AppText accessibilityRole="header" variant="display">
              {invalid ? "Invite unavailable" : "Request not approved"}
            </AppText>
            <StatusBadge
              icon="!"
              label={invalid ? "Invalid or expired" : "Not approved"}
              tone="warning"
            />
            <AppText tone="secondary">
              {invalid
                ? "That invite is invalid or has expired."
                : "This join request was not approved. You can use a different invite."}
            </AppText>
          </Stack>
          <Button
            accessibilityHint="Returns to invite code entry."
            label="Use another code"
            onPress={state.onUseAnotherCode}
          />
        </Stack>
      </Screen>
    );
  }

  if (state.kind === "failed") {
    return (
      <Screen testID="join-trip-screen">
        <Stack gap="xl">
          <InlineBanner
            body="Check your connection and try again. Your request has not been changed."
            icon="!"
            title="CrewRoll could not check this invite"
            tone="warning"
          />
          <Button
            accessibilityHint="Safely retries the same join action."
            label="Try again"
            loading={state.retrying ?? false}
            onPress={state.onRetry}
          />
        </Stack>
      </Screen>
    );
  }

  return (
    <Screen testID="join-trip-screen">
      <Stack gap="xl">
        <Stack gap="sm">
          <AppText tone="action" variant="eyebrow">
            Join recovery
          </AppText>
          <AppText accessibilityRole="header" variant="display">
            Checking your join request
          </AppText>
          <StatusBadge icon="…" label="Checking safely" tone="info" />
          <AppText tone="secondary">
            CrewRoll is checking whether your request was received. Keep this
            phone connected and check again.
          </AppText>
        </Stack>
        <Button
          accessibilityHint="Replays the original request without creating another membership."
          label="Check join request"
          loading={state.retrying ?? false}
          onPress={state.onRetry}
        />
      </Stack>
    </Screen>
  );
}

type JoinRequestFormProps = Readonly<{
  initialCode: string;
  onCancel: () => void;
  onJoin: (inviteCode: string) => void;
  submitting: boolean;
}>;

function JoinRequestForm({
  initialCode,
  onCancel,
  onJoin,
  submitting,
}: JoinRequestFormProps) {
  const [code, setCode] = useState(() => normalizeCode(initialCode));
  const [confirming, setConfirming] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>();
  const normalizedCode = normalizeCode(code);
  const showConfirmation = confirming || submitting;

  function continueToConfirmation() {
    if (!inviteCodePattern.test(normalizedCode)) {
      setLocalError(invalidLocalCode);
      return;
    }

    setCode(normalizedCode);
    setLocalError(undefined);
    setConfirming(true);
  }

  if (showConfirmation) {
    return (
      <Screen testID="join-trip-screen">
        <Stack gap="xl">
          <Stack gap="sm">
            <AppText tone="action" variant="eyebrow">
              Confirm invite
            </AppText>
            <AppText accessibilityRole="header" variant="display">
              Join this trip?
            </AppText>
            <StatusBadge
              icon={submitting ? "…" : "✓"}
              label={submitting ? "Requesting access" : "Code ready"}
              tone={submitting ? "info" : "success"}
            />
          </Stack>

          <Surface muted>
            <Stack gap="xs">
              <AppText variant="bodyStrong">
                Request access with invite code {normalizedCode}.
              </AppText>
              <AppText tone="secondary">
                The trip owner will approve this phone before photos can arrive.
              </AppText>
            </Stack>
          </Surface>

          <Stack gap="sm">
            <Button
              accessibilityHint="Sends this join request once."
              label="Request to join"
              loading={submitting}
              onPress={() => onJoin(normalizedCode)}
            />
            {submitting ? null : (
              <Button
                accessibilityHint="Returns to invite code entry without sending a request."
                label="Back"
                onPress={() => setConfirming(false)}
                variant="secondary"
              />
            )}
          </Stack>
        </Stack>
      </Screen>
    );
  }

  return (
    <Screen keyboardShouldPersistTaps="handled" testID="join-trip-screen">
      <Stack gap="xl">
        <Stack gap="sm">
          <AppText tone="action" variant="eyebrow">
            Your crew is waiting
          </AppText>
          <AppText accessibilityRole="header" variant="display">
            Join a trip
          </AppText>
          <AppText tone="secondary">
            Enter the readable code from the trip owner. You will confirm it
            before CrewRoll sends a request.
          </AppText>
        </Stack>

        <TextField
          {...(localError === undefined ? {} : { errorMessage: localError })}
          accessibilityHint="Enter the 8-character CrewRoll invite code."
          autoCapitalize="characters"
          autoCorrect={false}
          label="Invite code"
          maxLength={8}
          onChangeText={(value) => {
            setCode(value.toUpperCase());
            setLocalError(undefined);
          }}
          placeholder="ABCD2345"
          returnKeyType="done"
          supportingText="Eight letters or numbers"
          value={code}
        />

        <Stack gap="sm">
          <Button
            accessibilityHint="Checks this code locally before confirmation."
            label="Continue"
            onPress={continueToConfirmation}
          />
          <Button
            accessibilityHint="Leaves without sending a join request."
            label="Cancel"
            onPress={onCancel}
            variant="secondary"
          />
        </Stack>
      </Stack>
    </Screen>
  );
}

export function JoinTripScreen({
  initialCode = "",
  onCancel,
  onJoin,
  state = { kind: "editing" },
}: JoinTripScreenProps) {
  if (state.kind !== "editing" && state.kind !== "submitting") {
    return <ResultScreen state={state} />;
  }

  return (
    <JoinRequestForm
      initialCode={initialCode}
      key={initialCode}
      onCancel={onCancel}
      onJoin={onJoin}
      submitting={state.kind === "submitting"}
    />
  );
}
