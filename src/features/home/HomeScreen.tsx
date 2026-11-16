import { toUserFacingProblem } from "../../application/problems/userFacingProblem";
import type { ReactNode } from "react";

import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";

import {
  AppText,
  Button,
  useCrewRollTheme,
  FlowScreen,
  spacing,
  radius,
  Stack,
} from "../../design-system";
import { HomeHeader } from "./HomeHeader";

export type HomeScreenState =
  | Readonly<{ kind: "no-trip"; creationFailed?: boolean }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; onRetry: () => void; retrying?: boolean }>
  | Readonly<{
      kind: "unknown-create";
      onRecover: () => void;
      recovering?: boolean;
    }>;

export type HomeScreenProps = Readonly<{
  invitation?: ReactNode;
  inviteUnavailable?: boolean;
  rejoinUnavailable?: boolean;
  accountControl?: ReactNode;
  statusContent?: ReactNode;
  canCreateTrip?: boolean;
  onCreateTrip: () => void;
  onJoinTrip: () => void;
  state?: HomeScreenState;
}>;

export function HomeScreen({
  invitation,
  inviteUnavailable = false,
  rejoinUnavailable = false,
  accountControl,
  statusContent,
  canCreateTrip = true,
  onCreateTrip,
  onJoinTrip,
  state = { kind: "no-trip" },
}: HomeScreenProps) {
  const colors = useCrewRollTheme();
  const header = <HomeHeader accountControl={accountControl} />;
  if (invitation)
    return (
      <FlowScreen
        testID="home-screen"
        header={header}
        pinnedHeader
        centerContent
      >
        {invitation}
      </FlowScreen>
    );
  if (state.kind !== "no-trip")
    return (
      <FlowScreen
        testID="home-screen"
        header={header}
        pinnedHeader
        centerContent
      >
        <Stack gap="md">
          <AppText
            accessibilityRole="header"
            variant="title1"
            style={styles.centeredText}
          >
            {state.kind === "failed"
              ? "Your trips couldn’t load."
              : "Checking your trip."}
          </AppText>
          {state.kind === "loading" ? statusContent : null}
          {state.kind === "failed" ? (
            <Button
              label="Try again"
              loading={state.retrying ?? false}
              onPress={state.onRetry}
            />
          ) : state.kind === "unknown-create" ? (
            <Button
              label="Check request"
              onPress={state.onRecover}
              loading={state.recovering ?? false}
            />
          ) : null}
        </Stack>
      </FlowScreen>
    );
  const notice = rejoinUnavailable
    ? toUserFacingProblem("TRIP_REJOIN_UNAVAILABLE").message
    : inviteUnavailable
      ? "This invite is no longer available. Ask your host for a new code."
      : state.creationFailed
        ? "Your trip wasn’t created. Give it another try."
        : null;
  return (
    <FlowScreen testID="home-screen" header={header} pinnedHeader centerContent>
      {statusContent}
      <View style={[styles.mark, { backgroundColor: colors.accentSurface }]}>
        <Image
          source={require("../../../assets/onboarding/crew-center.svg")}
          style={styles.icon}
        />
      </View>
      <Stack gap="xs">
        <AppText accessibilityRole="header" variant="title1">
          Start or join a trip
        </AppText>
        <AppText tone="secondary">
          Start a shared roll with friends, or enter a code from your host.
        </AppText>
        {notice ? (
          <AppText accessibilityRole="alert" tone="critical">
            {notice}
          </AppText>
        ) : null}
      </Stack>
      <Stack gap="xs">
        <Button
          label="Start a trip"
          disabled={!canCreateTrip}
          onPress={onCreateTrip}
        />
        <Button
          label="Enter invite code"
          variant="secondary"
          disabled={!canCreateTrip}
          onPress={onJoinTrip}
        />
      </Stack>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  centeredText: { textAlign: "center" },
  mark: {
    alignSelf: "flex-start",
    padding: spacing.md,
    borderRadius: radius.xl,
  },
  icon: { width: 48, height: 48 },
});
