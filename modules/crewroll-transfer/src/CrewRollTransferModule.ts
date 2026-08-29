import { requireNativeModule } from "expo";

import type { CrewRollTransferNativeModule } from "./CrewRollTransfer.types";

let nativeModule: CrewRollTransferNativeModule | undefined;

export function getCrewRollTransferNativeModule(): CrewRollTransferNativeModule {
  nativeModule ??=
    requireNativeModule<CrewRollTransferNativeModule>("CrewRollTransfer");
  return nativeModule;
}
