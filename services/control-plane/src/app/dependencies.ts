import type { Logger } from "pino";

import type { Environment } from "../config/env.js";
import type { Clock } from "../shared/time/clock.js";

export interface IdGenerator {
  uuid(): string;
}

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
