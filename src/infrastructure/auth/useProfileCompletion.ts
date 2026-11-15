import { useUser } from "@clerk/expo";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { profileName } from "../../domain/auth/profileName";
import { withDeadline } from "../../application/shared/withDeadline";
import { profileSyncCache, type ProfileSyncCache } from "./profileSyncCache";

const CACHE_READ_DEADLINE_MS = 2_000;
const PROFILE_OPERATION_DEADLINE_MS = 20_000;

type ProfileApi = { syncProfile(): Promise<{ displayName: string }> };
type State = {
  accountId: string;
  scope: string;
  name: string;
  ready: boolean;
  busy: boolean;
  error: string | null;
  inputRequired: boolean;
};

export function useProfileCompletion({
  api,
  scope,
  cache = profileSyncCache,
}: {
  api: ProfileApi;
  scope: string;
  cache?: ProfileSyncCache;
}) {
  const { isLoaded, user } = useUser();
  const accountId = user?.id ?? null;
  const canonicalName =
    profileName(user?.fullName) ??
    profileName(user?.firstName) ??
    profileName(user?.username);
  const [state, setState] = useState<State | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const working = useRef<object | null>(null);
  const submitted = useRef<{ epoch: number; name: string } | null>(null);
  useLayoutEffect(() => {
    const epoch = ++generation.current;
    working.current = null;
    return () => {
      generation.current = epoch + 1;
    };
  }, [accountId, scope]);

  useEffect(() => {
    if (!isLoaded || !accountId || working.current) return;
    const epoch = generation.current;
    // user.update also changes useUser. Its render must not start a second
    // sync or silently retry a failed submission while save() owns this name.
    if (
      submitted.current?.epoch === epoch &&
      submitted.current.name === canonicalName
    )
      return;
    let disposed = false;
    const current = () => !disposed && epoch === generation.current;
    if (!canonicalName) return;
    const operation = {};
    working.current = operation;
    void (async () => {
      // This cache only avoids a redundant profile sync. A locked/unavailable
      // keychain must never become the source of truth for account readiness.
      const cached = await withDeadline(
        () => cache.read(scope, accountId),
        CACHE_READ_DEADLINE_MS,
      ).catch(() => null);
      if (!current()) return;
      if (cached !== canonicalName) {
        const response = await withDeadline(
          () => api.syncProfile(),
          PROFILE_OPERATION_DEADLINE_MS,
        );
        if (!current()) return;
        if (response.displayName !== canonicalName)
          throw new Error("PROFILE_SYNC_PENDING");
        void withDeadline(
          () => cache.write(scope, accountId, canonicalName),
          CACHE_READ_DEADLINE_MS,
        ).catch(() => undefined);
      }
      if (current())
        setState({
          accountId,
          scope,
          name: canonicalName,
          ready: true,
          busy: false,
          error: null,
          inputRequired: false,
        });
    })()
      .catch(() => {
        if (current())
          setState((previous) => ({
            accountId,
            scope,
            name: canonicalName,
            ready: false,
            busy: false,
            error: "Your name couldn’t sync. Please try again.",
            inputRequired:
              previous?.accountId === accountId &&
              previous.scope === scope &&
              previous.inputRequired === true,
          }));
      })
      .finally(() => {
        if (working.current === operation) working.current = null;
      });
    return () => {
      disposed = true;
      if (working.current === operation) working.current = null;
    };
  }, [accountId, api, cache, canonicalName, isLoaded, retry, scope]);

  const visible =
    state?.accountId === accountId && state.scope === scope ? state : null;
  async function save() {
    if (!user || !accountId || working.current) return;
    const name = profileName(visible?.name);
    if (!name) {
      setState({
        accountId,
        scope,
        name: visible?.name ?? "",
        ready: false,
        busy: false,
        error: "Enter a name using 1–80 characters.",
        inputRequired: true,
      });
      return;
    }
    const epoch = generation.current;
    submitted.current = { epoch, name };
    const operation = {};
    working.current = operation;
    setState({
      accountId,
      scope,
      name,
      ready: false,
      busy: true,
      error: null,
      inputRequired: true,
    });
    try {
      if (name !== canonicalName)
        await withDeadline(
          () => user.update({ firstName: name, lastName: null }),
          PROFILE_OPERATION_DEADLINE_MS,
        );
      if (epoch !== generation.current) return;
      const response = await withDeadline(
        () => api.syncProfile(),
        PROFILE_OPERATION_DEADLINE_MS,
      );
      if (epoch !== generation.current) return;
      if (response.displayName !== name)
        throw new Error("PROFILE_SYNC_PENDING");
      void withDeadline(
        () => cache.write(scope, accountId, name),
        CACHE_READ_DEADLINE_MS,
      ).catch(() => undefined);
      if (epoch === generation.current)
        setState({
          accountId,
          scope,
          name,
          ready: true,
          busy: false,
          error: null,
          inputRequired: false,
        });
    } catch {
      if (epoch === generation.current)
        setState({
          accountId,
          scope,
          name,
          ready: false,
          busy: false,
          error: "Your name couldn’t save. Please try again.",
          inputRequired: true,
        });
    } finally {
      if (working.current === operation) working.current = null;
    }
  }

  return {
    accountId,
    ready:
      isLoaded &&
      (!accountId ||
        (visible?.ready === true && visible.name === canonicalName)),
    checking:
      !isLoaded ||
      (accountId !== null &&
        canonicalName !== null &&
        (!visible || (visible.ready && visible.name !== canonicalName))),
    requiresInput:
      isLoaded &&
      accountId !== null &&
      (canonicalName === null || visible?.inputRequired === true),
    name: visible?.name ?? canonicalName ?? "",
    busy: visible?.busy ?? false,
    error: visible?.error ?? null,
    setName(name: string) {
      if (!accountId || working.current) return;
      setState({
        accountId,
        scope,
        name,
        ready: false,
        busy: false,
        error: null,
        inputRequired: true,
      });
    },
    save,
    retry() {
      submitted.current = null;
      setRetry((value) => value + 1);
    },
  };
}
