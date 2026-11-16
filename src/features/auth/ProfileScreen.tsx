import {
  AppText,
  Button,
  CrewRollHeader,
  FlowScreen,
  Stack,
  TextField,
} from "../../design-system";

export function ProfileScreen({
  name,
  setName,
  busy,
  error,
  onSave,
  onUseAnotherAccount,
}: Readonly<{
  name: string;
  setName(value: string): void;
  busy: boolean;
  error: string | null;
  onSave(): void;
  onUseAnotherAccount(): void;
}>) {
  return (
    <FlowScreen
      testID="profile-screen"
      pinnedHeader
      pinnedFooter
      header={<CrewRollHeader />}
      centerContent
      footer={
        <>
          <Button
            label="Continue"
            loading={busy}
            disabled={!name.trim()}
            onPress={onSave}
          />
          <Button
            label="Use another account"
            variant="text"
            disabled={busy}
            onPress={onUseAnotherAccount}
          />
        </>
      }
    >
      <Stack gap="sm">
        <AppText accessibilityRole="header" variant="title1">
          Your name.
        </AppText>
        <AppText tone="secondary">So your crew knows who’s sharing.</AppText>
      </Stack>
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder="Your name"
        autoComplete="name"
        textContentType="name"
        autoCapitalize="words"
        autoCorrect={false}
        maxLength={160}
        disabled={busy}
        returnKeyType="done"
        onSubmitEditing={onSave}
      />
      {error ? (
        <AppText accessibilityRole="alert" tone="critical" variant="label">
          {error}
        </AppText>
      ) : null}
    </FlowScreen>
  );
}
