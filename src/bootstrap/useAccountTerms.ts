import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
    policyKnown: false,
  });
  const generation = useRef(0);
  const accepting = useRef(false);
  const policyRead = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const knownPolicy = useRef<Readonly<{
    accountId: string;
    attempt: number;
  }> | null>(null);
  useLayoutEffect(() => {
    const current = ++generation.current;
    ++policyRead.current;
    accepting.current = false;
    knownPolicy.current = null;
    return () => {
      generation.current = current + 1;
    };
  }, [api, accountId]);
  useEffect(() => {
    if (!accountId) return;
    // An existing account can check consent while its canonical name restores.
    // A first-time profile may not exist on the backend yet; its successful
    // sync changes profileReady and retries a previously unknown policy read.
    if (
      knownPolicy.current?.accountId === accountId &&
      knownPolicy.current.attempt === attempt
    )
      return;
    const current = generation.current;
    const read = ++policyRead.current;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled &&
      generation.current === current &&
      policyRead.current === read;
    void withDeadline(() => api.getAccountPolicy(), POLICY_DEADLINE_MS).then(
      (policy) => {
        if (isCurrent()) {
          knownPolicy.current = { accountId, attempt };
          setState({
            accountId,
            accepted: policy.accepted,
            checking: false,
            busy: false,
            error: null,
            policyKnown: true,
          });
        }
      },
      () => {
        if (isCurrent())
          setState((previous) => ({
            accountId,
            accepted: previous.accountId === accountId && previous.accepted,
            checking: false,
            busy: false,
            policyKnown:
              previous.accountId === accountId && previous.policyKnown,
            error: profileReady
              ? "Couldn’t load your account terms. Please try again."
              : null,
          }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, accountId, profileReady, attempt]);
  const accept = useCallback(async () => {
    if (
      !accountId ||
      accepting.current ||
      state.accountId !== accountId ||
      !state.policyKnown ||
      state.checking ||
      state.accepted
    )
      return;
    const current = generation.current;
    accepting.current = true;
    ++policyRead.current;
    setState((value) => ({ ...value, busy: true, error: null }));
    try {
      const result = await withDeadline(
        () => api.acceptAccountTerms(),
        POLICY_DEADLINE_MS,
      );
      if (generation.current === current) {
        knownPolicy.current = { accountId, attempt };
        setState({
          accountId,
          accepted: result.accepted,
          checking: false,
          busy: false,
          error: null,
          policyKnown: true,
        });
      }
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
  }, [
    api,
    accountId,
    attempt,
    state.accountId,
    state.checking,
    state.accepted,
    state.policyKnown,
  ]);
  return {
    accountId: state.accountId,
    accepted: state.accepted,
    busy: state.busy,
    error: state.error,
    checking: state.accountId !== accountId || state.checking,
    ready: state.accountId === accountId && state.policyKnown && state.accepted,
    requiresInput:
      state.accountId === accountId && state.policyKnown && !state.accepted,
    accept,
    retry: () => {
      if (accepting.current) return;
      ++policyRead.current;
      setState((previous) => ({
        accountId,
        accepted: previous.accountId === accountId && previous.accepted,
        policyKnown: previous.accountId === accountId && previous.policyKnown,
        checking: true,
        busy: false,
        error: null,
      }));
      setAttempt((value) => value + 1);
    },
  };
}
