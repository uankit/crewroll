import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountApi } from "../infrastructure/api/crewRollApi";

export function useAccountTerms(
  api: AccountApi,
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
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const current = ++generation.current;
    if (!accountId || !profileReady) return;
    void api.getAccountPolicy().then(
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
  const accepting = useRef(false);
  const accept = useCallback(async () => {
    if (!accountId || accepting.current) return;
    const current = generation.current;
    accepting.current = true;
    setState((value) => ({ ...value, busy: true, error: null }));
    try {
      const result = await api.acceptAccountTerms();
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
      accepting.current = false;
    }
  }, [api, accountId]);
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
