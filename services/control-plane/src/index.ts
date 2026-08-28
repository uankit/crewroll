import { installCrewRollFormats } from "@crewroll/contracts";
import { FormatRegistry } from "@sinclair/typebox";

installCrewRollFormats(FormatRegistry);

export const controlPlaneWorkspace = {
  apiVersion: "v1",
  workerEnabled: true,
} as const;
