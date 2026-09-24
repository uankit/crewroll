import { useRef, useState } from "react";
import { Keyboard, StyleSheet, View } from "react-native";
import type { TripInvitePreview } from "../../domain/trips/model";
import {
  AppText,
  Button,
  FlowScreen,
  FlowTransition,
  MemberAvatar,
  Stack,
  TextField,
  radius,
  spacing,
  useCrewRollTheme,
} from "../../design-system";

export type JoinTripScreenState =
  | Readonly<{ kind: "editing" | "submitting" }>
  | Readonly<{ kind: "invalid" | "rejected"; onUseAnotherCode: () => void }>
  | Readonly<{
      kind: "failed" | "unknown";
      onRetry: () => void;
      retrying?: boolean;
    }>;

export type JoinTripScreenProps = Readonly<{
  initialCode?: string;
  onCancel: () => void;
  onLookup: (inviteCode: string) => Promise<TripInvitePreview>;
  onJoin: (inviteCode: string) => void;
  state?: JoinTripScreenState;
}>;
const inviteCodePattern = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const normalizeCode = (value: string) => value.replace(/\s/g, "").toUpperCase();

export function JoinTripScreen({
  initialCode = "",
  onCancel,
  onLookup,
  onJoin,
  state = { kind: "editing" },
}: JoinTripScreenProps) {
  const colors = useCrewRollTheme();
  const [code, setCode] = useState(() => normalizeCode(initialCode));
  const [preview, setPreview] = useState<TripInvitePreview | null>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const inFlight = useRef(false);
  const joining = useRef(false);
  async function findTrip() {
    if (inFlight.current) return;
    const normalized = normalizeCode(code);
    if (!inviteCodePattern.test(normalized)) {
      setError("Enter the complete 8-character invite code.");
      return;
    }
    inFlight.current = true;
    Keyboard.dismiss();
    setFinding(true);
    setError(undefined);
    try {
      setPreview(await onLookup(normalized));
      setCode(normalized);
    } catch (failure) {
      const invalid =
        typeof failure === "object" &&
        failure !== null &&
        "code" in failure &&
        failure.code === "INVITE_INVALID";
      setError(
        invalid
          ? "That code is invalid, expired, or the trip has ended. Check with your host."
          : "The trip couldn’t load. Check your connection and try again.",
      );
    } finally {
      inFlight.current = false;
      setFinding(false);
    }
  }
  if (state.kind === "failed" || state.kind === "unknown")
    return (
      <FlowTransition step="recovery">
        <FlowScreen
          testID="join-trip-screen"
          title="Checking your request."
          description="Your request may already have reached your host. Check the same request to continue."
          footer={
            <Button
              label="Check join request"
              loading={state.retrying ?? false}
              onPress={state.onRetry}
            />
          }
        />
      </FlowTransition>
    );
  if (state.kind === "invalid" || state.kind === "rejected")
    return (
      <FlowTransition step="unavailable">
        <FlowScreen
          testID="join-trip-screen"
          title={
            state.kind === "invalid"
              ? "Invite unavailable."
              : "Request not approved."
          }
          description={
            state.kind === "invalid"
              ? "That invite is invalid or has expired."
              : "Your host hasn’t approved this request. You can use another invite."
          }
          footer={
            <Button label="Use another code" onPress={state.onUseAnotherCode} />
          }
        />
      </FlowTransition>
    );
  const submitting = state.kind === "submitting";
  function backToCode() {
    if (submitting) return;
    setPreview(null);
    joining.current = false;
  }
  if (preview) {
    const dates = new Intl.DateTimeFormat(undefined, {
      dateStyle: "long",
    }).format(new Date(preview.endsAt));
    return (
      <FlowTransition step="preview">
        <FlowScreen
          testID="join-trip-screen"
          label="Your invitation"
          onBack={backToCode}
          title={preview.name}
          description={`${preview.startsAt ? "LIVE · " : ""}Until ${dates}`}
          footer={
            <>
              <Button
                label="Request to join"
                loading={submitting}
                onPress={() => {
                  if (joining.current) return;
                  joining.current = true;
                  onJoin(code);
                }}
              />
              <Button
                label="Not this trip"
                variant="text"
                disabled={submitting}
                onPress={backToCode}
              />
            </>
          }
        >
          <View
            style={[
              styles.crew,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <AppText tone="action" variant="eyebrow">
              Hosted by
            </AppText>
            <AppText variant="bodyStrong">{preview.hostDisplayName}</AppText>
            <View
              style={[styles.divider, { backgroundColor: colors.border }]}
            />
            <AppText variant="eyebrow" tone="secondary">
              Crew · {preview.members.length} joined
            </AppText>
            <Stack gap="none">
              {preview.members.map((member, index) => (
                <View
                  key={`${index}-${member.displayName}`}
                  style={[
                    styles.member,
                    index > 0 && {
                      borderTopWidth: 1,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <MemberAvatar displayName={member.displayName} />
                  <View style={styles.identity}>
                    <AppText variant="bodyStrong">{member.displayName}</AppText>
                    <AppText tone="secondary" variant="caption">
                      {member.role === "OWNER" ? "Host" : "Joined"}
                    </AppText>
                  </View>
                </View>
              ))}
            </Stack>
          </View>
          <AppText tone="secondary">
            Your roll starts when {preview.hostDisplayName.split(" ")[0]}{" "}
            approves. Photos from before that moment stay private.
          </AppText>
        </FlowScreen>
      </FlowTransition>
    );
  }
  return (
    <FlowTransition step="code">
      <FlowScreen
        testID="join-trip-screen"
        label="Join a trip"
        onBack={onCancel}
        title="Enter your code."
        description="Paste the 8-character code from your host."
        footer={
          <Button
            label="Find trip"
            loading={finding}
            onPress={() => void findTrip()}
          />
        }
      >
        <TextField
          label="Invite code"
          accessibilityHint="Enter the 8-character code from your host."
          value={code}
          autoCapitalize="characters"
          autoCorrect={false}
          disabled={finding}
          maxLength={32}
          onChangeText={(value) => {
            setCode(normalizeCode(value).slice(0, 8));
            setError(undefined);
          }}
          placeholder="XXXXXXXX"
          returnKeyType="go"
          onSubmitEditing={() => void findTrip()}
          {...(error === undefined ? {} : { errorMessage: error })}
        />
      </FlowScreen>
    </FlowTransition>
  );
}
const styles = StyleSheet.create({
  crew: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  divider: { height: 1 },
  member: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 56,
    paddingVertical: spacing.xs,
  },
  identity: { flex: 1, gap: spacing.xxs },
});
