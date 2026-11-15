import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  useContext,
} from "react";
import { Keyboard } from "react-native";
import { FlowTransition } from "../design-system/product/FlowTransition";
import { ProfileScreen } from "../features/auth/ProfileScreen";
import type { useProfileCompletion } from "../infrastructure/auth/useProfileCompletion";
import { TermsScreen } from "../features/auth/TermsScreen";
import type { useAccountTerms } from "./useAccountTerms";

type Setup = Readonly<{ required: boolean; screen: ReactNode }>;
const AccountSetupContext = createContext<Setup>({
  required: false,
  screen: null,
});

export function AccountSetupProvider({
  children,
  accountId,
  profile,
  onUseAnotherAccount,
  terms,
}: PropsWithChildren<{
  accountId: string | null;
  profile: ReturnType<typeof useProfileCompletion>;
  onUseAnotherAccount(): void;
  terms?: ReturnType<typeof useAccountTerms>;
}>) {
  const profileReady = profile.accountId === accountId && profile.ready;
  const profileInputRequired =
    profile.accountId === accountId && profile.requiresInput;
  const termsInputRequired =
    profileReady &&
    terms !== undefined &&
    terms.accountId === accountId &&
    terms.requiresInput;
  // Background account checks belong to the app's status surface. Setup only
  // owns a form when this account authoritatively needs the person's input.
  const required =
    accountId !== null && (profileInputRequired || termsInputRequired);
  const step = profileInputRequired ? "profile" : "terms";

  const screen = required ? (
    <FlowTransition step={step}>
      {step === "profile" ? (
        <ProfileScreen
          name={profile.name}
          setName={profile.setName}
          busy={profile.busy}
          error={profile.error}
          onSave={() => {
            Keyboard.dismiss();
            void profile.save();
          }}
          onUseAnotherAccount={onUseAnotherAccount}
        />
      ) : step === "terms" && terms ? (
        <TermsScreen
          busy={terms.busy || terms.checking}
          error={terms.error}
          onAccept={() => void terms.accept()}
          onRetry={terms.retry}
          onBack={onUseAnotherAccount}
        />
      ) : null}
    </FlowTransition>
  ) : null;

  return (
    <AccountSetupContext.Provider value={{ required, screen }}>
      {children}
    </AccountSetupContext.Provider>
  );
}

export function useAccountSetup() {
  return useContext(AccountSetupContext);
}
