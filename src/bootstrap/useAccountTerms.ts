import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountApi } from "../infrastructure/api/crewRollApi";
import { withDeadline } from "../application/shared/withDeadline";

const POLICY_DEADLINE_MS = 15_000;

export function useAccountTerms(
  api: Pick<AccountApi, "getAccountPolicy" | "acceptAccountTerms">,
  accountId: string | null,
  profileReady: boolean,
) {
  const [state, setState] = useState({
    accountId: null as string | null,
    accepted: false,
    checking: false,
    busy: false,
    error: null as string | null,
  });
  const generation = useRef(0);
  const accepting = useRef(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const current = ++generation.current;
    accepting.current = false;
    if (!accountId || !profileReady) return;
    void withDeadline(() => api.getAccountPolicy(), POLICY_DEADLINE_MS).then(
      (policy) => {
        if (generation.current === current)
          setState({
            accountId,
            accepted: policy.accepted,
            checking: false,
            busy: false,
            error: null,
          });
      },
      () => {
        if (generation.current === current)
          setState({
            accountId,
            accepted: false,
            checking: false,
            busy: false,
            error:
              "Couldn’t load your account. Check your connection and try again.",
          });
      },
    );
    return () => {
      generation.current = current + 1;
    };
  }, [api, accountId, profileReady, attempt]);
  const accept = useCallback(async () => {
    if (
      !accountId ||
      accepting.current ||
      state.accountId !== accountId ||
      state.checking ||
      state.accepted
    )
      return;
    const current = generation.current;
    accepting.current = true;
    setState((value) => ({ ...value, busy: true, error: null }));
    try {
      const result = await withDeadline(
        () => api.acceptAccountTerms(),
        POLICY_DEADLINE_MS,
      );
      if (generation.current === current)
        setState({
          accountId,
          accepted: result.accepted,
          checking: false,
          busy: false,
          error: null,
        });
    } catch {
      if (generation.current === current)
        setState((value) => ({
          ...value,
          busy: false,
          error: "Couldn’t save your choice. Please try again.",
        }));
    } finally {
      if (generation.current === current) accepting.current = false;
    }
  }, [api, accountId, state.accountId, state.checking, state.accepted]);
  return {
    ...state,
    checking: state.accountId !== accountId || state.checking,
    ready: profileReady && state.accountId === accountId && state.accepted,
    accept,
    retry: () => {
      setState({
        accountId,
        accepted: false,
        checking: true,
        busy: false,
        error: null,
      });
      setAttempt((value) => value + 1);
    },
  };
}
