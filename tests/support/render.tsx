import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react-native";
import type { ReactElement } from "react";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity, retry: false },
    },
  });
}

type RenderWithProvidersOptions = {
  readonly queryClient?: QueryClient;
};

export async function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
) {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const result = await render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );

  return { ...result, queryClient };
}
