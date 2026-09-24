import { useUser } from "@clerk/expo";
import { useRef, useState } from "react";

import {
  AppIcon,
  AppText,
  Button,
  IconButton,
  Sheet,
  Stack,
  useCrewRollTheme,
} from "../design-system";
import { SignOutControl } from "./SignOutControl";

export function AccountMenu() {
  const { user } = useUser();
  const theme = useCrewRollTheme();
  const [page, setPage] = useState<"account" | "sign-out" | null>(null);
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
        accessibilityHint="View your profile and sign out"
        icon={<AppIcon name="account" />}
        style={{ backgroundColor: theme.surfaceMuted, borderWidth: 0 }}
        onPress={() => setPage("account")}
      />
      {page !== null ? (
        <Sheet
          visible
          title={page === "account" ? "Your account" : "Sign out?"}
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
              <Button
                label="Sign out"
                variant="secondary"
                onPress={() => setPage("sign-out")}
              />
            </>
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
