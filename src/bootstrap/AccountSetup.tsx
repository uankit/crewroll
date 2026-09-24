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
}: PropsWithChildren<{
  accountId: string | null;
  profile: ReturnType<typeof useProfileCompletion>;
  scope: string;
  permission: PhotoLibraryPermissionPort;
  onUseAnotherAccount(): void;
}>) {
  const photo = usePhotoAccessSetup({ accountId, scope, permission });
  const profileReady = profile.accountId === accountId && profile.ready;
  const required = accountId !== null && (!profileReady || !photo.complete);
  const step = !profileReady
    ? profile.accountId !== accountId || profile.checking
      ? "loading"
      : "profile"
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
