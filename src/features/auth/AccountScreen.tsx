import { Image } from "expo-image";
import { LegalLinks } from "./LegalLinks";
import { useEffect } from "react";
import {
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import {
  AppText,
  Button,
  TextField,
  useCrewRollTheme,
  FlowScreen,
  FlowTransition,
  spacing,
  radius,
  onboardingGeometry,
} from "../../design-system";

export type AccountFlow = Readonly<{
  email: string;
  code: string;
  password: string;
  passwordRequired: boolean;
  verifying: boolean;
  busy: boolean;
  error: string | null;
  resendSeconds: number;
  setEmail(value: string): void;
  setCode(value: string): void;
  setPassword(value: string): void;
  submitEmail(): Promise<void>;
  submitPassword(): Promise<void>;
  useEmailCode(): Promise<void>;
  verify(): Promise<void>;
  resend(): Promise<void>;
  editEmail(): void;
  social(provider: "google" | "apple"): Promise<void>;
}>;

export function AccountScreen({
  flow,
  onBack,
}: Readonly<{ flow: AccountFlow; onBack: () => void }>) {
  useEffect(() => {
    Keyboard.dismiss();
  }, [flow.verifying, flow.passwordRequired]);
  return (
    <FlowTransition
      step={
        flow.passwordRequired ? "password" : flow.verifying ? "verify" : "email"
      }
    >
      <AccountContents flow={flow} onBack={onBack} />
    </FlowTransition>
  );
}

function AccountContents({
  flow,
  onBack,
}: Readonly<{ flow: AccountFlow; onBack: () => void }>) {
  const theme = useCrewRollTheme();
  const error = flow.error ? (
    <AppText accessibilityRole="alert" tone="critical" variant="label">
      {flow.error}
    </AppText>
  ) : null;
  if (flow.passwordRequired)
    return (
      <FlowScreen
        testID="password-screen"
        label="Your account"
        title="Welcome back."
        description={flow.email}
        onBack={flow.editEmail}
        footer={
          <Button
            label="Sign in"
            disabled={!flow.password}
            loading={flow.busy}
            onPress={() => void flow.submitPassword()}
          />
        }
      >
        <View style={styles.form}>
          <TextField
            label="Password"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            autoComplete="current-password"
            value={flow.password}
            onChangeText={flow.setPassword}
            disabled={flow.busy}
            {...(flow.error ? { errorMessage: flow.error } : {})}
            onSubmitEditing={() => void flow.submitPassword()}
            returnKeyType="go"
          />
          <Button
            label="Use an email code"
            variant="text"
            disabled={flow.busy}
            onPress={() => void flow.useEmailCode()}
          />
        </View>
      </FlowScreen>
    );
  if (flow.verifying)
    return (
      <FlowScreen
        testID="verification-screen"
        label="Verify email"
        onBack={flow.editEmail}
        footer={
          <>
            <Button
              label="Verify email"
              disabled={flow.code.length !== 6}
              loading={flow.busy}
              onPress={() => void flow.verify()}
            />
            <Button
              label="Use a different email"
              variant="text"
              disabled={flow.busy}
              onPress={flow.editEmail}
            />
          </>
        }
      >
        <View
          style={[styles.emailIcon, { backgroundColor: theme.surfaceMuted }]}
        >
          <Image
            source={require("../../../assets/onboarding/envelope.svg")}
            tintColor={theme.success}
            style={{ width: 26, height: 20 }}
          />
        </View>
        <View style={styles.intro}>
          <AppText accessibilityRole="header" variant="title1">
            Check your inbox.
          </AppText>
          <AppText tone="secondary">
            We sent a 6-digit code to{"\n"}
            {flow.email}.
          </AppText>
        </View>
        <View style={styles.intro}>
          <AppText variant="label">Verification code</AppText>
          <View style={styles.code}>
            <View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[styles.digits, { backgroundColor: theme.background }]}
            >
              {Array.from({ length: 6 }, (_, i) => (
                <View
                  key={i}
                  style={[
                    styles.digit,
                    {
                      borderColor: flow.error
                        ? theme.critical
                        : theme.textSecondary,
                      backgroundColor: theme.surface,
                    },
                  ]}
                >
                  <AppText variant="title2">{flow.code[i] ?? ""}</AppText>
                </View>
              ))}
            </View>
            <TextInput
              testID="verification-code"
              accessibilityLabel="Verification code"
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              autoCorrect={false}
              maxLength={6}
              value={flow.code}
              onChangeText={flow.setCode}
              editable={!flow.busy}
              caretHidden
              selectionColor={theme.transparent}
              style={[
                StyleSheet.absoluteFill,
                styles.codeInput,
                { color: theme.transparent },
              ]}
              onSubmitEditing={() => void flow.verify()}
            />
          </View>
          {flow.resendSeconds > 0 ? (
            <AppText variant="label" tone="secondary">
              Resend code in 00:{String(flow.resendSeconds).padStart(2, "0")}
            </AppText>
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={flow.busy}
              onPress={() => void flow.resend()}
              style={styles.resend}
            >
              <AppText variant="label" tone="action">
                Resend code
              </AppText>
            </Pressable>
          )}
          {error}
        </View>
        <AppText tone="secondary">
          Check your spam folder if it hasn’t arrived.
        </AppText>
      </FlowScreen>
    );

  return (
    <FlowScreen
      testID="account-screen"
      title="Good times start here."
      description="Sign in or create your account."
      label="Your account"
      onBack={onBack}
      footer={<LegalLinks />}
    >
      <View style={styles.intro}>
        <Button
          label="Continue with Google"
          variant="google"
          disabled={flow.busy}
          leading={
            <Image
              source={require("../../../assets/onboarding/google.png")}
              style={styles.providerIcon}
            />
          }
          onPress={() => void flow.social("google")}
        />
        {Platform.OS === "ios" ? (
          <Button
            label="Continue with Apple"
            variant="apple"
            disabled={flow.busy}
            leading={
              <Image
                source={require("../../../assets/onboarding/apple.svg")}
                style={styles.providerIcon}
              />
            }
            onPress={() => void flow.social("apple")}
          />
        ) : null}
      </View>
      <View style={styles.divider}>
        <View style={[styles.line, { backgroundColor: theme.border }]} />
        <AppText variant="caption" tone="secondary">
          or use email
        </AppText>
        <View style={[styles.line, { backgroundColor: theme.border }]} />
      </View>
      <View style={styles.form}>
        <TextField
          label="Email address"
          placeholder="you@example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          autoComplete="email"
          value={flow.email}
          onChangeText={flow.setEmail}
          disabled={flow.busy}
          onSubmitEditing={() => void flow.submitEmail()}
          returnKeyType="go"
        />
        {error}
        <Button
          label="Continue with email"
          loading={flow.busy}
          onPress={() => void flow.submitEmail()}
        />
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: spacing.sm },
  form: { gap: spacing.md },
  providerIcon: { width: 20, height: 20 },
  divider: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  line: { height: 1, flex: 1, maxWidth: 94 },
  terms: { textAlign: "center" },
  emailIcon: {
    width: 72,
    height: 72,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  code: { height: 64 },
  digits: {
    zIndex: 1,
    flexDirection: "row",
    gap: onboardingGeometry.codeGap,
    width: "100%",
    height: 64,
  },
  digit: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  // Keep the real input tappable and accessible below the opaque digit row.
  // Android IME composing spans can ignore a transparent text color.
  codeInput: { fontSize: 24, zIndex: 0 },
  resend: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
});
