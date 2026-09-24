import { useUser } from "@clerk/expo";
import { useRef, useState } from "react";
import { Linking } from "react-native";
import { AccountMenuRow } from "./AccountMenuRow";
import { DeleteAccountControl } from "./DeleteAccountControl";
import { BlockedMembers } from "./BlockedMembers";
import { useAccountPrivacy } from "./AccountPrivacy";

import {
  AppIcon,
  AppText,
  IconButton,
  Sheet,
  Stack,
  useCrewRollTheme,
} from "../design-system";
import { SignOutControl } from "./SignOutControl";

export function AccountMenu() {
  const { user } = useUser();
  const theme = useCrewRollTheme();
  const privacy = useAccountPrivacy();
  const [page, setPage] = useState<
    "account" | "sign-out" | "delete" | "blocked" | null
  >(null);
  const [linkFailed, setLinkFailed] = useState(false);
  const open = (path: string) => {
    setLinkFailed(false);
    void Linking.openURL(`https://crewroll.app/${path}`).catch(() =>
      setLinkFailed(true),
    );
  };
  const signingOut = useRef(false);
  const displayName =
    user?.fullName?.trim() || user?.firstName?.trim() || "Your account";
  const email = user?.primaryEmailAddress?.emailAddress;

  const dismiss = () => {
    if (!signingOut.current) setPage(null);
  };

  return (
    <>
      <IconButton
        label="Your account"
        accessibilityHint="View your profile, privacy and account settings"
        icon={<AppIcon name="account" />}
        style={{ backgroundColor: theme.surfaceMuted, borderWidth: 0 }}
        onPress={() => setPage("account")}
      />
      {page !== null ? (
        <Sheet
          visible
          title={
            page === "account"
              ? "Your account"
              : page === "delete"
                ? "Delete your account?"
                : page === "blocked"
                  ? "Blocked people"
                  : "Sign out?"
          }
          onDismiss={dismiss}
          contentStyle={{ backgroundColor: theme.background }}
          testID="account-sheet"
        >
          {page === "account" ? (
            <>
              <Stack gap="xs">
                <AppText variant="headline">{displayName}</AppText>
                {email ? <AppText tone="secondary">{email}</AppText> : null}
              </Stack>
              <Stack gap="none">
                <AccountMenuRow
                  label="Help & support"
                  onPress={() => open("support")}
                />
                <AccountMenuRow label="Terms" onPress={() => open("terms")} />
                <AccountMenuRow
                  label="Privacy"
                  onPress={() => open("privacy")}
                />
                {privacy ? (
                  <AccountMenuRow
                    label="Blocked people"
                    onPress={() => setPage("blocked")}
                  />
                ) : null}
              </Stack>
              <Stack gap="none">
                <AccountMenuRow
                  label="Sign out"
                  onPress={() => setPage("sign-out")}
                />
                {privacy ? (
                  <AccountMenuRow
                    label="Delete account"
                    critical
                    onPress={() => setPage("delete")}
                  />
                ) : null}
              </Stack>
              {linkFailed ? (
                <AppText tone="critical" accessibilityRole="alert">
                  Couldn’t open the page. Visit crewroll.app in your browser.
                </AppText>
              ) : null}
            </>
          ) : page === "delete" ? (
            <DeleteAccountControl
              onCancel={dismiss}
              onBusyChange={(busy) => {
                signingOut.current = busy;
              }}
            />
          ) : page === "blocked" ? (
            <BlockedMembers />
          ) : (
            <SignOutControl
              onCancel={dismiss}
              onBusyChange={(busy) => {
                signingOut.current = busy;
              }}
            />
          )}
        </Sheet>
      ) : null}
    </>
  );
}
