import {
  AppText,
  BrandLoading,
  Button,
  CrewRollHeader,
  FlowScreen,
  Screen,
  Stack,
} from "../../design-system";

const safeFailure =
  "Your saved session couldn’t be restored on this phone. Try again.";
export type ProvisioningScreenProps = (
  | Readonly<{ status: "working"; onRetry?: never; retrying?: never }>
  | Readonly<{ status: "failed"; onRetry: () => void; retrying?: boolean }>
) &
  Readonly<{
    purpose?: "sign-out";
    presentation?: Readonly<{ title: string; message: string }>;
    onSignOut?: () => void;
  }>;

export function ProvisioningScreen(props: ProvisioningScreenProps) {
  const signingOut = props.purpose === "sign-out";
  const failure = signingOut
    ? "CrewRoll could not finish signing out safely. Try again to stop transfers and close this session."
    : (props.presentation?.message ?? safeFailure);
  if (props.status === "working")
    return (
      <Screen scroll={false} testID="provisioning-screen">
        <BrandLoading
          message={
            signingOut
              ? "Signing out…"
              : (props.presentation?.title ?? "Restoring this phone")
          }
        />
        {!signingOut && props.onSignOut ? (
          <Button label="Sign out" variant="text" onPress={props.onSignOut} />
        ) : null}
      </Screen>
    );
  return (
    <FlowScreen
      testID="provisioning-screen"
      pinnedHeader
      pinnedFooter
      header={<CrewRollHeader />}
      centerContent
      footer={
        <Stack gap="sm">
          <Button
            label="Try again"
            loading={props.retrying ?? false}
            onPress={props.onRetry}
          />
          {!signingOut && props.onSignOut ? (
            <Button label="Sign out" variant="text" onPress={props.onSignOut} />
          ) : null}
        </Stack>
      }
    >
      <Stack gap="sm">
        <AppText accessibilityRole="header" variant="title1">
          {signingOut
            ? "Finish signing out."
            : (props.presentation?.title ?? "Restore this phone.")}
        </AppText>
        <AppText
          accessibilityRole="alert"
          accessibilityLabel={failure}
          tone="secondary"
        >
          {failure}
        </AppText>
      </Stack>
    </FlowScreen>
  );
}
