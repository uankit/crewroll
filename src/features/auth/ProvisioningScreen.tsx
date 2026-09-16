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
export type ProvisioningScreenProps =
  | Readonly<{ status: "working"; onRetry?: never; retrying?: never }>
  | Readonly<{ status: "failed"; onRetry: () => void; retrying?: boolean }>;

export function ProvisioningScreen(props: ProvisioningScreenProps) {
  if (props.status === "working")
    return (
      <Screen scroll={false} testID="provisioning-screen">
        <BrandLoading />
      </Screen>
    );
  return (
    <FlowScreen
      testID="provisioning-screen"
      header={<CrewRollWordmark />}
      title="Let’s reconnect."
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
        accessibilityLabel={safeFailure}
        tone="secondary"
      >
        {safeFailure}
      </AppText>
    </FlowScreen>
  );
}
