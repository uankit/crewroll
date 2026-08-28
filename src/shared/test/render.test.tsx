import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { Text } from "react-native";

import { createTestQueryClient, renderWithProviders } from "./render";

function QueryClientProbe({ expected }: { expected: QueryClient }) {
  const queryClient = useQueryClient();
  return <Text>{queryClient === expected ? "provided client" : "unexpected client"}</Text>;
}

describe("renderWithProviders", () => {
  it("makes the provided QueryClient available to descendants", async () => {
    const queryClient = new QueryClient();
    const view = await renderWithProviders(<QueryClientProbe expected={queryClient} />, {
      queryClient,
    });

    expect(view.getByText("provided client")).toBeTruthy();
  });

  it("returns the exact provided QueryClient", async () => {
    const queryClient = new QueryClient();

    const view = await renderWithProviders(<Text>child</Text>, { queryClient });

    expect(view.queryClient).toBe(queryClient);
  });

  it("disables query and mutation retries by default", () => {
    const queryClient = createTestQueryClient();

    expect(queryClient.getDefaultOptions().queries?.retry).toBe(false);
    expect(queryClient.getDefaultOptions().mutations?.retry).toBe(false);
  });

  it("does not schedule query or mutation cache eviction timers", () => {
    const queryClient = createTestQueryClient();

    expect(queryClient.getDefaultOptions().queries?.gcTime).toBe(Infinity);
    expect(queryClient.getDefaultOptions().mutations?.gcTime).toBe(Infinity);
  });

  it("creates isolated clients and caches for default renders", async () => {
    const first = await renderWithProviders(<Text>first</Text>);
    first.queryClient.setQueryData(["trip", "active"], { id: "trip-1" });
    await first.unmount();

    const second = await renderWithProviders(<Text>second</Text>);

    expect(second.queryClient).not.toBe(first.queryClient);
    expect(second.queryClient.getQueryData(["trip", "active"])).toBeUndefined();
  });
});
