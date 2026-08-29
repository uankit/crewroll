import type { Logger } from "pino";

import type { Environment } from "../config/env.js";
import type { IdGenerator } from "../shared/ids/idGenerator.js";
import type { Clock } from "../shared/time/clock.js";

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface AppDependencies {
  readonly clock: Clock;
  readonly environment: Environment;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly readiness: ReadinessProbe;
}
