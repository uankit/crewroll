import type { ComponentProps } from "react";
import { AccountSetupProvider } from "./AccountSetup";
import { useAppSession } from "./AppSessionProvider";

export function SessionAccountSetupProvider(
  props: Omit<
    ComponentProps<typeof AccountSetupProvider>,
    "onUseAnotherAccount"
  >,
) {
  const session = useAppSession();
  return (
    <AccountSetupProvider
      {...props}
      onUseAnotherAccount={() => {
        // The session provider owns the visible, retryable teardown failure.
        void session.signOut().catch(() => {});
      }}
    />
  );
}
