import { describe, expect, it } from "vitest";

import { EnvironmentError, loadEnvironment } from "../../src/config/env.js";

const developmentEnvironment = {
  DATABASE_URL: "postgresql://crewroll:local@127.0.0.1:5432/crewroll",
  HOST: "127.0.0.1",
  LOG_LEVEL: "info",
  NODE_ENV: "development",
  PORT: "3000",
} satisfies NodeJS.ProcessEnv;

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

const productionOnlyKeys = Object.keys(productionProviderEnvironment).sort();

function captureEnvironmentError(source: NodeJS.ProcessEnv): EnvironmentError {
  try {
    loadEnvironment(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvironmentError);
    return error as EnvironmentError;
  }
  throw new Error("Expected environment parsing to fail");
}

describe("loadEnvironment", () => {
  it("parses the smallest development environment without reading globals", () => {
    const environment = loadEnvironment(developmentEnvironment);

    expect(environment).toMatchObject({
      databaseUrl: developmentEnvironment.DATABASE_URL,
      debugCorsOrigins: [],
      host: "127.0.0.1",
      logLevel: "info",
      nodeEnvironment: "development",
      port: 3000,
    });
    expect(environment.clerkSecretKey).toBeUndefined();
    expect(environment.firebaseServiceAccountJson).toBeUndefined();
  });

  it.each(["development", "test", "production"] as const)(
    "accepts the %s runtime mode",
    (nodeEnvironment) => {
      const environment = loadEnvironment({
        ...developmentEnvironment,
        ...(nodeEnvironment === "production"
          ? productionProviderEnvironment
          : {}),
        NODE_ENV: nodeEnvironment,
      });

      expect(environment.nodeEnvironment).toBe(nodeEnvironment);
    },
  );

  it.each([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ] as const)("accepts the %s log level", (logLevel) => {
    const environment = loadEnvironment({
      ...developmentEnvironment,
      LOG_LEVEL: logLevel,
    });

    expect(environment.logLevel).toBe(logLevel);
  });

  it.each([
    ["1", 1],
    ["65535", 65535],
  ])("accepts port %s", (input, expected) => {
    expect(
      loadEnvironment({ ...developmentEnvironment, PORT: input }).port,
    ).toBe(expected);
  });

  it.each([
    ["NODE_ENV", "staging"],
    ["HOST", "   "],
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "1.5"],
    ["PORT", "not-a-port"],
    ["LOG_LEVEL", "verbose"],
    ["DATABASE_URL", "mysql://database.example.test/crewroll"],
  ])("rejects invalid %s", (key, value) => {
    const error = captureEnvironmentError({
      ...developmentEnvironment,
      [key]: value,
    });

    expect(error.invalidKeys).toEqual([key]);
    expect(error.message).toBe(`Invalid environment keys: ${key}`);
    expect(error.message).not.toContain(value);
  });

  it.each(productionOnlyKeys)("requires %s in production", (missingKey) => {
    const source: NodeJS.ProcessEnv = {
      ...developmentEnvironment,
      ...productionProviderEnvironment,
      NODE_ENV: "production",
    };
    delete source[missingKey];

    const error = captureEnvironmentError(source);

    expect(error.invalidKeys).toEqual([missingKey]);
  });

  it.each(["not-json", "[]", '"scalar"', "null"])(
    "rejects Firebase service account JSON that is not an object",
    (value) => {
      const error = captureEnvironmentError({
        ...developmentEnvironment,
        ...productionProviderEnvironment,
        FIREBASE_SERVICE_ACCOUNT_JSON: value,
        NODE_ENV: "production",
      });

      expect(error.invalidKeys).toEqual(["FIREBASE_SERVICE_ACCOUNT_JSON"]);
      expect(error.message).not.toContain(value);
    },
  );

  it("normalizes an exact non-production browser origin list", () => {
    const environment = loadEnvironment({
      ...developmentEnvironment,
      DEBUG_CORS_ORIGINS: "https://debug.crewroll.test, http://127.0.0.1:19006",
    });

    expect(environment.debugCorsOrigins).toEqual([
      "https://debug.crewroll.test",
      "http://127.0.0.1:19006",
    ]);
  });

  it.each([
    "https://debug.crewroll.test,",
    "https://debug.crewroll.test,https://debug.crewroll.test",
    "https://user:password@debug.crewroll.test",
    "https://debug.crewroll.test/path",
    "https://debug.crewroll.test?token=secret",
    "https://debug.crewroll.test#fragment",
    "ftp://debug.crewroll.test",
  ])("rejects an unsafe debug origin list", (debugOrigins) => {
    const error = captureEnvironmentError({
      ...developmentEnvironment,
      DEBUG_CORS_ORIGINS: debugOrigins,
    });

    expect(error.invalidKeys).toEqual(["DEBUG_CORS_ORIGINS"]);
    expect(error.message).not.toContain(debugOrigins);
  });

  it("rejects a browser debug allowlist in production", () => {
    const error = captureEnvironmentError({
      ...developmentEnvironment,
      ...productionProviderEnvironment,
      DEBUG_CORS_ORIGINS: "https://debug.crewroll.test",
      NODE_ENV: "production",
    });

    expect(error.invalidKeys).toEqual(["DEBUG_CORS_ORIGINS"]);
  });

  it("reports only sorted unique invalid key names without secret values", () => {
    const secretCanary = "environment-secret-canary-5ea179";
    const error = captureEnvironmentError({
      ...developmentEnvironment,
      DATABASE_URL: `mysql://${secretCanary}@database.example.test/crewroll`,
      DEBUG_CORS_ORIGINS: `https://${secretCanary}@debug.crewroll.test/path`,
      PORT: secretCanary,
    });

    expect(error.invalidKeys).toEqual([
      "DATABASE_URL",
      "DEBUG_CORS_ORIGINS",
      "PORT",
    ]);
    expect(error.message).toBe(
      "Invalid environment keys: DATABASE_URL, DEBUG_CORS_ORIGINS, PORT",
    );
    expect(error.message).not.toContain(secretCanary);
  });
});
