import { createContext, type PropsWithChildren, useContext } from "react";

import type { AcceptedTripMutationKind } from "../application/trips/ports";
import type { SafeClerkClaimMetadata } from "../dev/SafeClerkClaimInspector";

export type DevelopmentAcceptanceControl = Readonly<{
  arm(kind: AcceptedTripMutationKind): Promise<void>;
  clear(): Promise<void>;
  inspectClaims(): Promise<SafeClerkClaimMetadata | null>;
}>;

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
