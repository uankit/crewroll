import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AppState, BackHandler } from "react-native";

import type { PhotoLibraryPermissionState } from "../infrastructure/media/expoPhotoLibraryPermission";
import { PhotoAccessScreen } from "../features/trips/PhotoAccessScreen";
import { PhotoAccessRequired, useAppSession } from "./AppSessionProvider";
import { AccountMenu } from "./AccountMenu";

type Permission =
  PhotoLibraryPermissionState | Readonly<{ kind: "CHECKING" | "UNAVAILABLE" }>;

/** New trip admission uses the shared native grant, independently of existing trips. */
export function useTripPhotoAdmission(enabled: boolean, onCancel: () => void) {
  const { actions, queryScope } = useAppSession();
  const latest = useRef({ enabled, actions, queryScope });
  const generation = useRef(0);
  const requesting = useRef(false);
  const cancel = useRef(onCancel);
  useLayoutEffect(() => {
    latest.current = { enabled, actions, queryScope };
    cancel.current = onCancel;
  }, [actions, enabled, onCancel, queryScope]);
  const invalidateAttempt = useCallback(() => {
    ++generation.current;
  }, []);
  const lastAccount = useRef(queryScope?.opaqueAccountScope);
  const [result, setResult] = useState<{
    actions: typeof actions;
    queryScope: typeof queryScope;
    permission: Permission;
    error?: string;
  } | null>(null);
  const scoped =
    result !== null &&
    result.actions === actions &&
    result.queryScope === queryScope;
  const permission: Permission = scoped
    ? result.permission
    : { kind: "CHECKING" };

  const refresh = useCallback(
    async (requestPermission = false) => {
      if (!enabled || !actions || requesting.current) return;
      const attempt = ++generation.current;
      requesting.current = requestPermission;
      const isCurrent = () =>
        generation.current === attempt &&
        latest.current.enabled &&
        latest.current.actions === actions &&
        latest.current.queryScope === queryScope;
      setResult({ actions, queryScope, permission: { kind: "CHECKING" } });
      try {
        const permission = await actions.checkPhotoAccess(requestPermission);
        if (isCurrent()) setResult({ actions, queryScope, permission });
      } catch {
        if (isCurrent())
          setResult({
            actions,
            queryScope,
            permission: { kind: "UNAVAILABLE" },
          });
      } finally {
        if (generation.current === attempt) requesting.current = false;
      }
    },
    [actions, enabled, queryScope],
  );

  useEffect(() => {
    requesting.current = false;
    if (!enabled || !actions) return;
    const account = queryScope?.opaqueAccountScope;
    const changedAccount =
      lastAccount.current !== undefined &&
      account !== undefined &&
      lastAccount.current !== account;
    if (account !== undefined) lastAccount.current = account;
    if (changedAccount) {
      ++generation.current;
      cancel.current();
      return;
    }
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        // Returning from Settings reads the actual grant and never reprompts.
        if (!requesting.current) void refresh();
      } else if (!requesting.current) {
        ++generation.current;
        setResult({ actions, queryScope, permission: { kind: "CHECKING" } });
      }
    });
    return () => {
      invalidateAttempt();
      subscription.remove();
    };
  }, [actions, enabled, invalidateAttempt, queryScope, refresh]);

  const ready = !enabled || permission.kind === "FULL";
  useEffect(() => {
    if (!enabled || ready) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        cancel.current();
        return true;
      },
    );
    return () => subscription.remove();
  }, [enabled, ready]);

  function block(error: unknown): boolean {
    if (!(error instanceof PhotoAccessRequired)) return false;
    ++generation.current;
    requesting.current = false;
    setResult({
      actions,
      queryScope,
      permission: error.permission ?? { kind: "UNAVAILABLE" },
    });
    return true;
  }

  async function continueSetup() {
    if (!actions) return;
    if (permission.kind !== "SETTINGS_REQUIRED") {
      await refresh(permission.kind !== "UNAVAILABLE");
      return;
    }
    try {
      await actions.openPhotoSettings();
    } catch {
      if (
        latest.current.enabled &&
        latest.current.actions === actions &&
        latest.current.queryScope === queryScope
      )
        setResult({
          actions,
          queryScope,
          permission,
          error: "Photo settings couldn’t open. Try again.",
        });
    }
  }

  return {
    ready,
    block,
    screen: (
      <PhotoAccessScreen
        accountControl={<AccountMenu />}
        requiredBeforeTrip
        checking={permission.kind === "CHECKING"}
        settingsRequired={permission.kind === "SETTINGS_REQUIRED"}
        unavailable={permission.kind === "UNAVAILABLE"}
        {...("reason" in permission ? { reason: permission.reason } : {})}
        {...(scoped && result.error ? { error: result.error } : {})}
        onContinue={() => void continueSetup()}
        onLater={onCancel}
      />
    ),
  };
}
