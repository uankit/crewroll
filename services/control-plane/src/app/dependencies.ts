import type { Logger } from "pino";

import type { Environment } from "../config/env.js";
import type { IdGenerator } from "../shared/ids/idGenerator.js";
import type { Clock } from "../shared/time/clock.js";
import type { DeviceRouteDependencies } from "../modules/devices/index.js";
import type { ClerkWebhookRouteDependencies } from "../modules/identity/index.js";
import type { TripRouteDependencies } from "../modules/trips/index.js";

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface AppDependencies {
  readonly clock: Clock;
  readonly devices: DeviceRouteDependencies;
  readonly environment: Environment;
  readonly identity: ClerkWebhookRouteDependencies;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly readiness: ReadinessProbe;
  readonly trips: TripRouteDependencies;
}
