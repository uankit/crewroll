import type { ReactNode } from "react";
import { CrewRollHeader } from "../../design-system";

export function HomeHeader({ accountControl }: { accountControl?: ReactNode }) {
  return <CrewRollHeader accountControl={accountControl} />;
}
