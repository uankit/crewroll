import { renderHook } from "@testing-library/react-native";
import { useState } from "react";

import {
  createCrewRollApi,
  CrewRollTransportProblem,
} from "../infrastructure/api/crewRollApi";
import { useApiSessionBinding } from "./useApiSessionBinding";

const accountA = JSON.stringify(["account-a", "session-a"]);
const accountB = JSON.stringify(["account-b", "session-b"]);

function clerkIdentity() {
  const clerk: {
    user: { id: string } | null;
    session: { id: string } | null;
  } = {
    user: { id: "account-a" },
    session: { id: "session-a" },
  };
  return clerk;
}

it("opens API ownership only when the committed hook and synchronous SDK agree", async () => {
  const clerk = clerkIdentity();
  const view = await renderHook<
    () => string | null,
    { committed: string | null }
  >(({ committed }) => useApiSessionBinding(clerk, committed), {
    initialProps: { committed: accountA },
  });
  const originalGetter = view.result.current;
  expect(originalGetter()).toBe(accountA);
  clerk.user = { id: "account-b" };
  clerk.session = { id: "session-b" };
  expect(originalGetter()).toBeNull();
  await view.rerender({ committed: accountB });
  expect(view.result.current).toBe(originalGetter);
  expect(originalGetter()).toBe(accountB);
  await view.unmount();
  expect(originalGetter()).toBeNull();
});

it("keeps ownership closed when React commits a new session before the SDK changes", async () => {
  const clerk = clerkIdentity();
  const view = await renderHook<
    () => string | null,
    { committed: string | null }
  >(({ committed }) => useApiSessionBinding(clerk, committed), {
    initialProps: { committed: accountA },
  });
  await view.rerender({ committed: accountB });
  expect(view.result.current()).toBeNull();
  clerk.user = { id: "account-b" };
  clerk.session = { id: "session-b" };
  expect(view.result.current()).toBe(accountB);
});

it("closes ownership when the SDK signs out or changes the same account's session", async () => {
  const clerk = clerkIdentity();
  const view = await renderHook(() => useApiSessionBinding(clerk, accountA));
  clerk.session = { id: "session-two" };
  expect(view.result.current()).toBeNull();
  clerk.session = null;
  clerk.user = null;
  expect(view.result.current()).toBeNull();
});

it("prevents API dispatch if Clerk supplies a new account's token before useAuth commits", async () => {
  const clerk = clerkIdentity();
  const fetcher = jest.fn(
    async () =>
      new Response(
        JSON.stringify({ termsVersion: "2026-09-24", accepted: true }),
      ),
  );
  const getToken = jest.fn(async () => {
    // This is Clerk's synchronous active-session change, without a React render.
    clerk.user = { id: "account-b" };
    clerk.session = { id: "session-b" };
    return "account-b-token";
  });
  const view = await renderHook(() => {
    const sessionBinding = useApiSessionBinding(clerk, accountA);
    const [api] = useState(() =>
      createCrewRollApi({
        apiBaseUrl: "https://api.example",
        fetch: fetcher,
        sessionTokenSource: { getToken },
        sessionBinding,
      }),
    );
    return api;
  });
  await expect(view.result.current.getAccountPolicy()).rejects.toBeInstanceOf(
    CrewRollTransportProblem,
  );
  expect(getToken).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
});
