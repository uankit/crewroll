import type { DestinationStream } from "pino";

import type {
  AppDependencies,
  ReadinessProbe,
} from "../../src/app/dependencies.js";
import { loadEnvironment, type NodeEnvironment } from "../../src/config/env.js";
import { createSafeLogger } from "../../src/shared/observability/safeLogger.js";

export const fixedRequestId = "9a8c65b7-113f-44d0-86df-3f8d455f4d55";

class FakeReadinessProbe implements ReadinessProbe {
  checks = 0;

  constructor(private readonly failure: Error | undefined) {}

  check(): Promise<void> {
    this.checks += 1;
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve();
  }
}

const productionProviderEnvironment = {
  APNS_BUNDLE_ID: "com.uankit53.crewroll",
  APNS_KEY_ID: "apns_key",
  APNS_PRIVATE_KEY: "apns_private_key",
  APNS_TEAM_ID: "apns_team",
  AWS_REGION: "ap-south-1",
  CLERK_AUDIENCE: "crewroll-mobile",
  CLERK_ISSUER: "https://clerk.example.test",
  CLERK_SECRET_KEY: "clerk_secret",
  CLERK_WEBHOOK_SECRET: "clerk_webhook_secret",
  FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"crewroll"}',
  INVITE_CODE_HMAC_KEY: "invite_hmac_key",
  KMS_PUSH_TOKEN_KEY_ID: "kms_push_key",
  MEDIA_BUCKET: "crewroll-media",
} satisfies NodeJS.ProcessEnv;

interface TestDependenciesOptions {
  readonly debugCorsOrigins?: string;
  readonly nodeEnvironment?: NodeEnvironment;
  readonly readinessFailure?: Error;
}

export function createTestDependencies({
  debugCorsOrigins,
  nodeEnvironment = "test",
  readinessFailure,
}: TestDependenciesOptions = {}) {
  let logOutput = "";
  const destination: DestinationStream = {
    write(message) {
      logOutput += message;
    },
  };
  const environment = loadEnvironment({
    DATABASE_URL: "postgresql://crewroll:test@127.0.0.1:5432/crewroll_test",
    HOST: "127.0.0.1",
    LOG_LEVEL: "trace",
    NODE_ENV: nodeEnvironment,
    PORT: "3000",
    ...(nodeEnvironment === "production" ? productionProviderEnvironment : {}),
    ...(debugCorsOrigins === undefined
      ? {}
      : { DEBUG_CORS_ORIGINS: debugCorsOrigins }),
  });
  const readiness = new FakeReadinessProbe(readinessFailure);
  const dependencies: AppDependencies = {
    clock: { now: () => new Date("2026-08-29T12:00:00.000Z") },
    environment,
    ids: { uuid: () => fixedRequestId },
    logger: createSafeLogger(environment, destination),
    readiness,
  };

  return {
    dependencies,
    logRecords(): Record<string, unknown>[] {
      return logOutput
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    logs(): string {
      return logOutput;
    },
    readiness,
  };
}
