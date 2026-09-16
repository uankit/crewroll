import type { TripInvitePreview } from "../../domain/trips/model";
import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";

import {
  AppText,
  Button,
  CrewRollWordmark,
  useCrewRollTheme,
  FlowScreen,
  spacing,
  radius,
  onboardingGeometry,
} from "../../design-system";

export type HomeScreenState =
  | Readonly<{ kind: "no-trip"; creationFailed?: boolean }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; onRetry: () => void; retrying?: boolean }>
  | Readonly<{
      kind: "unknown-create" | "unknown-join" | "pending-approval";
      onRecover: () => void;
      recovering?: boolean;
      preview?: TripInvitePreview | null;
    }>;

export type HomeScreenProps = Readonly<{
  onCreateTrip: () => void;
  onJoinTrip: () => void;
  state?: HomeScreenState;
}>;

function CrewConstellation() {
  const colors = useCrewRollTheme();
  return (
    <View
      accessible
      accessibilityLabel="Everyone’s view. One shared roll."
      style={styles.constellation}
    >
      <Image
        source={require("../../../assets/onboarding/crew-connections.svg")}
        style={styles.connections}
        contentFit="fill"
      />
      <View style={[styles.center, { backgroundColor: colors.accentSurface }]}>
        <Image
          source={require("../../../assets/onboarding/crew-center.svg")}
          style={{ width: 52, height: 52 }}
        />
      </View>
      {(
        [
          { label: "A", left: "7.5%", top: 32 },
          { label: "R", left: "77.4%", top: 32 },
          { label: "M", left: "19.7%", top: 180 },
          { label: "+2", left: "65.2%", top: 180 },
        ] as const
      ).map(({ label, left, top }) => (
        <View
          key={label}
          style={[
            styles.avatar,
            {
              left,
              top,
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          <AppText variant="label" tone="action">
            {label}
          </AppText>
        </View>
      ))}
      <AppText variant="bodyStrong" style={styles.caption}>
        Everyone’s view. One shared roll.
      </AppText>
    </View>
  );
}

export function HomeScreen({
  onCreateTrip,
  onJoinTrip,
  state = { kind: "no-trip" },
}: HomeScreenProps) {
  const colors = useCrewRollTheme();
  if (state.kind !== "no-trip") {
    const pending = state.kind === "pending-approval";
    return (
      <FlowScreen
        testID="home-screen"
        header={
          pending ? (
            <AppText
              tone="secondary"
              variant="label"
              style={{ textAlign: "right" }}
            >
              {state.preview?.name ?? "Your invitation"}
            </AppText>
          ) : (
            <CrewRollWordmark />
          )
        }
        title={
          pending
            ? `Waiting for ${state.preview?.hostDisplayName ?? "your host"}.`
            : state.kind === "failed"
              ? "Let’s reconnect."
              : "Opening your trip."
        }
        description={
          pending
            ? `We’ll bring you into ${state.preview?.name ?? "the trip"} as soon as ${state.preview?.hostDisplayName ?? "your host"} approves you.`
            : state.kind === "failed"
              ? "Check your connection and try again."
              : "Your trip will appear here in a moment."
        }
        footer={
          state.kind === "failed" ? (
            <Button
              label="Try again"
              onPress={state.onRetry}
              loading={state.retrying ?? false}
            />
          ) : pending ? (
            <AppText
              tone="secondary"
              variant="caption"
              style={{ textAlign: "center" }}
            >
              No photos are shared until you’re approved.
            </AppText>
          ) : state.kind === "unknown-create" ||
            state.kind === "unknown-join" ? (
            <Button
              label="Check request"
              loading={state.recovering ?? false}
              onPress={state.onRecover}
            />
          ) : undefined
        }
      >
        <View
          style={[styles.automatic, { backgroundColor: colors.surfaceMuted }]}
        >
          <AppText variant="label" style={{ color: colors.success }}>
            {pending ? "Checking automatically" : "Connecting to your trip"}
          </AppText>
        </View>
        {pending ? (
          <AppText tone="secondary">
            You can leave this screen. We’ll update it when your host responds.
          </AppText>
        ) : null}
      </FlowScreen>
    );
  }
  return (
    <FlowScreen
      testID="home-screen"
      header={<CrewRollWordmark />}
      title="Start your first trip."
      centerContent
      description={
        state.creationFailed
          ? "Your trip wasn’t created. Give it another try."
          : "Create one, or join your crew with a code."
      }
      footer={
        <>
          <Button label="Start a trip" onPress={onCreateTrip} />
          <Button
            label="Enter invite code"
            variant="text"
            onPress={onJoinTrip}
          />
        </>
      }
    >
      <CrewConstellation />
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  constellation: { height: 300, width: "100%" },
  connections: { position: "absolute", top: 0, width: "100%", height: 230 },
  center: {
    position: "absolute",
    top: 76,
    left: "50%",
    marginLeft: -onboardingGeometry.sharedCenterSize / 2,
    width: 112,
    height: 112,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  avatar: {
    position: "absolute",
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  caption: {
    position: "absolute",
    top: 254,
    width: "100%",
    textAlign: "center",
  },
  automatic: { borderRadius: radius.md, padding: spacing.md },
});
