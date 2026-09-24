import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { Linking } from "react-native";
import type { AccountApi } from "../infrastructure/api/crewRollApi";
import { AppText, Button, FlowScreen, Stack } from "../design-system";
import { SessionLoadingScreen } from "./SessionLoadingScreen";
import {
  clearPendingErasure,
  readPendingErasure,
  rememberPendingErasure,
  type PendingLocalErasure,
} from "../infrastructure/storage/accountLocalData";

type Privacy = {
  api: AccountApi;
  deleteAccount(accountId: string): Promise<void>;
};
const AccountPrivacyContext = createContext<Privacy | null>(null);
export function AccountPrivacyProvider({
  children,
  api,
  eraseLocalAccount,
  signOut,
  ready,
}: PropsWithChildren<{
  api: AccountApi;
  eraseLocalAccount(accountId: string): Promise<void>;
  signOut(): Promise<void>;
  ready: boolean;
}>) {
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState<PendingLocalErasure | null>(null);
  const [finished, setFinished] = useState(false);
  const [failed, setFailed] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  const running = useRef(false);
  const finish = async (record: PendingLocalErasure) => {
    if (running.current) return;
    running.current = true;
    setPending(record);
    setFailed(false);
    try {
      await rememberPendingErasure(record);
      await eraseLocalAccount(record.accountId);
      await signOut();
      await clearPendingErasure();
      setFinished(true);
    } catch {
      setFailed(true);
    } finally {
      running.current = false;
    }
  };
  useEffect(() => {
    if (!ready || checked) return;
    let active = true;
    void readPendingErasure().then(
      (record) => {
        if (!active) return;
        setChecked(true);
        if (record) void finish(record);
      },
      () => {
        if (active) {
          setFailed(true);
          setChecked(true);
        }
      },
    );
    return () => {
      active = false;
    };
    // Startup recovery is intentionally one-shot; finish uses the current bindings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, checked]);
  if (!checked) return <SessionLoadingScreen />;
  const openStatus = () => {
    if (!pending) return;
    void Linking.openURL(
      `https://crewroll.app/delete-account?request=${pending.requestId}`,
    ).then(
      () => setLinkFailed(false),
      () => setLinkFailed(true),
    );
  };
  if (pending)
    return (
      <FlowScreen
        label="Your account"
        centerContent
        {...(linkFailed ? { onBack: () => setLinkFailed(false) } : {})}
        footer={
          linkFailed ? (
            <Button label="Try again" onPress={openStatus} />
          ) : finished ? (
            <Button
              label="Done"
              onPress={() => {
                setPending(null);
                setFinished(false);
              }}
            />
          ) : failed ? (
            <Button label="Try again" onPress={() => void finish(pending)} />
          ) : undefined
        }
      >
        <Stack gap="md">
          <AppText
            accessibilityRole="header"
            variant="title1"
            style={{ fontSize: 28, lineHeight: 36 }}
          >
            {failed || linkFailed
              ? "Let’s try again."
              : finished
                ? "Request saved."
                : "Clearing data."}
          </AppText>
          <AppText tone="secondary">
            {linkFailed
              ? "The status page couldn’t open. Check your connection and try again."
              : failed
                ? "Your deletion request is saved. Unlock your phone and try again to finish clearing its private data."
                : finished
                  ? "You’re signed out. Your account and temporary shared copies are being removed. This usually takes a few minutes; allow up to 7 days."
                  : "Your request is saved. We’re removing CrewRoll’s private data from this phone."}
          </AppText>
          {finished && !linkFailed ? (
            <AppText variant="caption" tone="secondary">
              Saved photos stay in everyone’s library.{" "}
              <AppText
                variant="caption"
                accessibilityRole="link"
                style={{ textDecorationLine: "underline" }}
                onPress={openStatus}
              >
                Check deletion status
              </AppText>
            </AppText>
          ) : null}
        </Stack>
      </FlowScreen>
    );
  if (failed)
    return (
      <FlowScreen
        centerContent
        footer={
          <Button
            label="Try again"
            onPress={() => {
              setFailed(false);
              setChecked(false);
            }}
          />
        }
      >
        <Stack gap="md">
          <AppText
            accessibilityRole="header"
            variant="title1"
            style={{ fontSize: 28, lineHeight: 36 }}
          >
            Unlock phone.
          </AppText>
          <AppText tone="secondary">
            Unlock your phone so CrewRoll can open its secure storage.
          </AppText>
        </Stack>
      </FlowScreen>
    );
  return (
    <AccountPrivacyContext.Provider
      value={{
        api,
        async deleteAccount(accountId) {
          const receipt = await api.requestAccountDeletion();
          await finish({ accountId, requestId: receipt.requestId });
        },
      }}
    >
      {children}
    </AccountPrivacyContext.Provider>
  );
}
export const useAccountPrivacy = () => useContext(AccountPrivacyContext);
