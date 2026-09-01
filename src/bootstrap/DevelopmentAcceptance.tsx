import { createContext, type PropsWithChildren, useContext } from "react";

import type { AcceptedTripMutationKind } from "../application/trips/ports";

export type SafeDevelopmentClaims = Readonly<{
  issuer: string;
  authorizedParty: string | null;
}>;

export type DevelopmentAcceptanceControl = Readonly<{
  arm(kind: AcceptedTripMutationKind): Promise<void>;
  clear(): Promise<void>;
  inspectClaims(): Promise<SafeDevelopmentClaims | null>;
  afterAccepted(
    input: Readonly<{
      kind: AcceptedTripMutationKind;
      commandId: string;
    }>,
  ): Promise<void>;
}>;

export function createDevelopmentAcceptanceControl(
  getToken: () => Promise<string | null>,
): DevelopmentAcceptanceControl {
  const controller = import("../dev/TripMutationResponseCut").then(
    ({ DevelopmentTripMutationResponseCut, createExpoResponseCutArmStore }) =>
      new DevelopmentTripMutationResponseCut(createExpoResponseCutArmStore()),
  );
  return Object.freeze({
    async arm(kind) {
      await (await controller).arm(kind);
    },
    async clear() {
      await (await controller).clear();
    },
    async afterAccepted(input) {
      await (await controller).afterAccepted(input);
    },
    async inspectClaims() {
      const token = await getToken();
      if (token === null) return null;
      const { inspectClerkToken } =
        await import("../dev/SafeClerkClaimInspector");
      return inspectClerkToken(token);
    },
  });
}

export function composeDevelopmentAcceptance(
  development: boolean,
  createControl: () => DevelopmentAcceptanceControl,
): DevelopmentAcceptanceControl | null {
  return development ? createControl() : null;
}

const Context = createContext<DevelopmentAcceptanceControl | null>(null);

export function DevelopmentAcceptanceProvider({
  children,
  value,
}: PropsWithChildren<{ value: DevelopmentAcceptanceControl | null }>) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDevelopmentAcceptance(): DevelopmentAcceptanceControl {
  const value = useContext(Context);
  if (value === null) throw new Error("development acceptance unavailable");
  return value;
}
