import { QueryClient } from "@tanstack/react-query";

import { clearForegroundQueryState } from "./queryClient";

it("never clears a new account's queries when old cancellation finishes late", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
  let finishCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    finishCancellation = resolve;
  });
  jest.spyOn(client, "cancelQueries").mockReturnValueOnce(cancellation);
  client.setQueryData(["trip", "old-account"], "old-private-trip");

  const clearing = clearForegroundQueryState(client);
  expect(client.getQueryData(["trip", "old-account"])).toBeUndefined();
  client.setQueryData(["trip", "new-account"], "new-private-trip");

  finishCancellation();
  await clearing;
  expect(client.getQueryData(["trip", "new-account"])).toBe("new-private-trip");
  client.clear();
});
