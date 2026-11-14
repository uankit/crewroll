import {
  AppText,
  BrandLoading,
  Button,
  CrewRollWordmark,
  FlowScreen,
  Screen,
} from "../../design-system";

const safeFailure =
  "CrewRoll could not connect this phone. Check your connection and try again.";
export type ProvisioningScreenProps = (
  | Readonly<{ status: "working"; onRetry?: never; retrying?: never }>
  | Readonly<{ status: "failed"; onRetry: () => void; retrying?: boolean }>
) &
  Readonly<{ purpose?: "sign-out" }>;

export function ProvisioningScreen(props: ProvisioningScreenProps) {
  const signingOut = props.purpose === "sign-out";
  const failure = signingOut
    ? "CrewRoll could not finish signing out safely. Try again to stop transfers and close this session."
    : safeFailure;
  if (props.status === "working")
    return (
      <Screen scroll={false} testID="provisioning-screen">
        <BrandLoading {...(signingOut ? { message: "Signing out…" } : {})} />
      </Screen>
    );
  return (
    <FlowScreen
      testID="provisioning-screen"
      header={<CrewRollWordmark />}
      title={signingOut ? "Finish signing out." : "Let’s reconnect."}
      centerContent
      footer={
        <Button
          label="Try again"
          loading={props.retrying ?? false}
          onPress={props.onRetry}
        />
      }
    >
      <AppText
        accessibilityRole="alert"
        accessibilityLabel={failure}
        tone="secondary"
      >
        {failure}
      </AppText>
    </FlowScreen>
  );
}
