import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import type {
  PhotoLibraryPermissionPort,
  PhotoLibraryPermissionState,
} from "../infrastructure/media/expoPhotoLibraryPermission";
import {
  photoAccessSetupCache,
  type PhotoAccessSetupCache,
} from "../infrastructure/media/photoAccessSetupCache";

type State = Readonly<{
  accountId: string;
  scope: string;
  complete: boolean;
  permission: PhotoLibraryPermissionState | null;
  busy: boolean;
  unavailable: boolean;
}>;

export function usePhotoAccessSetup({
  accountId,
  scope,
  permission,
  cache = photoAccessSetupCache,
}: Readonly<{
  accountId: string | null;
  scope: string;
  permission: PhotoLibraryPermissionPort;
  cache?: PhotoAccessSetupCache;
}>) {
  const [state, setState] = useState<State | null>(null);
  const generation = useRef(0);
  const working = useRef(false);
  const visible =
    state?.accountId === accountId && state?.scope === scope ? state : null;
  const awaitingAccess = visible !== null && !visible.complete;

  useLayoutEffect(() => {
    const epoch = ++generation.current;
    working.current = false;
    return () => {
      generation.current = epoch + 1;
    };
  }, [accountId, scope, permission, cache]);

  useEffect(() => {
    if (!accountId) return;
    const epoch = generation.current;
    let disposed = false;
    void Promise.all([
      permission.read().catch(() => null),
      cache.read(scope, accountId).catch(() => false),
    ]).then(([access, remembered]) => {
      if (disposed || epoch !== generation.current) return;
      setState({
        accountId,
        scope,
        permission: access,
        complete: remembered || access?.kind === "FULL",
        busy: false,
        unavailable: access === null,
      });
      if (access?.kind === "FULL")
        void cache.write(scope, accountId).catch(() => {});
    });
    return () => {
      disposed = true;
    };
  }, [accountId, scope, permission, cache]);

  useEffect(() => {
    if (!accountId || !awaitingAccess) return;
    const epoch = generation.current;
    let previous = AppState.currentState;
    const listener = AppState.addEventListener("change", (next) => {
      const returned = previous !== "active" && next === "active";
      previous = next;
      // Native prompts also emit foreground events. Their request owns the result.
      if (!returned || working.current) return;
      working.current = true;
      void permission
        .read()
        .then((access) => {
          if (epoch !== generation.current) return;
          setState({
            accountId,
            scope,
            permission: access,
            complete: access.kind === "FULL",
            busy: false,
            unavailable: false,
          });
          if (access.kind === "FULL")
            void cache.write(scope, accountId).catch(() => {});
        })
        .catch(() => {
          if (epoch === generation.current)
            setState((current) => current && { ...current, unavailable: true });
        })
        .finally(() => {
          if (epoch === generation.current) working.current = false;
        });
    });
    return () => listener.remove();
  }, [accountId, scope, permission, cache, awaitingAccess]);

  async function request() {
    if (!accountId || !visible || visible.complete || working.current) return;
    const epoch = generation.current;
    working.current = true;
    setState({ ...visible, busy: true, unavailable: false });
    try {
      if (visible.permission?.kind === "SETTINGS_REQUIRED") {
        await permission.openSettings();
      } else {
        const access = await permission.request();
        if (epoch !== generation.current) return;
        setState({
          accountId,
          scope,
          permission: access,
          complete: access.kind === "FULL",
          busy: false,
          unavailable: false,
        });
        if (access.kind === "FULL")
          void cache.write(scope, accountId).catch(() => {});
      }
    } catch {
      if (epoch === generation.current)
        setState((current) => current && { ...current, unavailable: true });
    } finally {
      if (epoch === generation.current) {
        working.current = false;
        setState((current) => current && { ...current, busy: false });
      }
    }
  }

  function defer() {
    if (!accountId || !visible || working.current) return;
    setState({ ...visible, complete: true });
    void cache.write(scope, accountId).catch(() => {});
  }

  return {
    complete: accountId === null || visible?.complete === true,
    checking: accountId !== null && visible === null,
    busy: visible?.busy ?? false,
    unavailable: visible?.unavailable ?? false,
    settingsRequired: visible?.permission?.kind === "SETTINGS_REQUIRED",
    request,
    defer,
  };
}
