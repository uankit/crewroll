import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  useContext,
} from "react";
import { Keyboard } from "react-native";
import { FlowTransition } from "../design-system/product/FlowTransition";
import { ProfileScreen } from "../features/auth/ProfileScreen";
import { PhotoAccessScreen } from "../features/trips/PhotoAccessScreen";
import type { useProfileCompletion } from "../infrastructure/auth/useProfileCompletion";
import type { PhotoLibraryPermissionPort } from "../infrastructure/media/expoPhotoLibraryPermission";
import { usePhotoAccessSetup } from "./usePhotoAccessSetup";
import { SessionLoadingScreen } from "./SessionLoadingScreen";
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
  scope,
  permission,
  onUseAnotherAccount,
  terms,
}: PropsWithChildren<{
  accountId: string | null;
  profile: ReturnType<typeof useProfileCompletion>;
  scope: string;
  permission: PhotoLibraryPermissionPort;
  onUseAnotherAccount(): void;
  terms?: ReturnType<typeof useAccountTerms>;
}>) {
  const photo = usePhotoAccessSetup({ accountId, scope, permission });
  const profileReady = profile.accountId === accountId && profile.ready;
  const termsReady = terms === undefined || terms.ready;
  const required =
    accountId !== null && (!profileReady || !termsReady || !photo.complete);
  const step = !profileReady
    ? profile.accountId !== accountId || profile.checking
      ? "loading"
      : "profile"
    : !termsReady
      ? terms?.checking
        ? "loading"
        : "terms"
      : photo.checking
        ? "loading"
        : "photos";

  const screen = (
    <FlowTransition step={step}>
      {step === "loading" ? (
        <SessionLoadingScreen />
      ) : step === "profile" ? (
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
          busy={terms.busy}
          error={terms.error}
          onAccept={() => void terms.accept()}
          onRetry={terms.retry}
          onBack={onUseAnotherAccount}
        />
      ) : (
        <PhotoAccessScreen
          checking={photo.busy}
          unavailable={photo.unavailable}
          settingsRequired={photo.settingsRequired}
          onContinue={() => void photo.request()}
          onLater={photo.defer}
        />
      )}
    </FlowTransition>
  );

  return (
    <AccountSetupContext.Provider value={{ required, screen }}>
      {children}
    </AccountSetupContext.Provider>
  );
}

export function useAccountSetup() {
  return useContext(AccountSetupContext);
}
