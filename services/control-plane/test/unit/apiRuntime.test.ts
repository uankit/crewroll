import { describe, expect, it, vi } from "vitest";

import {
  createApiRuntime,
  type ApiRuntimeFactories,
} from "../../src/api/apiRuntime.js";

const stages = [
  "environment",
  "logger",
  "clock",
  "ids",
  "database",
  "tokenVerifier",
  "webhookVerifier",
  "directory",
  "backgroundCredentials",
  "pushTokenProtector",
  "snapshots",
  "unitOfWork",
  "identityUnitOfWork",
  "registerDevice",
  "updateDevicePushToken",
  "revokeDevice",
  "clerkWebhookService",
  "buildApp",
] as const;
type Stage = (typeof stages)[number];

function createRuntimeHarness(
  options: {
    readonly appCloseFailure?: boolean;
    readonly databaseDestroyFailure?: boolean;
    readonly kmsDestroyFailure?: boolean;
    readonly listenFailure?: boolean;
    readonly throwAt?: Stage;
  } = {},
) {
  const calls: string[] = [];
  const environment = { host: "127.0.0.1", port: 3000, slot: "environment" };
  const logger = { slot: "logger" };
  const clock = { now: () => new Date(), slot: "clock" };
  const ids = { slot: "ids", uuid: () => "id" };
  const database = { slot: "database" };
  const tokenVerifier = { slot: "tokenVerifier" };
  const webhookVerifier = { slot: "webhookVerifier" };
  const directory = { slot: "directory" };
  const backgroundCredentials = { slot: "backgroundCredentials" };
  const protector = { slot: "protector" };
  const snapshots = { slot: "snapshots" };
  const unitOfWork = { slot: "unitOfWork" };
  const identityUnitOfWork = { slot: "identityUnitOfWork" };
  const registerDevice = { slot: "registerDevice" };
  const updateDevicePushToken = { slot: "updateDevicePushToken" };
  const revokeDevice = { slot: "revokeDevice" };
  const webhookService = { slot: "webhookService" };
  const close = vi.fn(() =>
    options.appCloseFailure
      ? Promise.reject(new Error("app close canary"))
      : Promise.resolve(),
  );
  const listen = vi.fn(() =>
    options.listenFailure
      ? Promise.reject(new Error("listen canary"))
      : Promise.resolve("http://127.0.0.1:3000"),
  );
  const destroyDatabase = vi.fn(() =>
    options.databaseDestroyFailure
      ? Promise.reject(new Error("database destroy canary"))
      : Promise.resolve(),
  );
  const destroyKms = vi.fn(() => {
    if (options.kmsDestroyFailure) throw new Error("kms destroy canary");
  });

  function step<Value>(stage: Stage, value: Value): Value {
    calls.push(stage);
    if (options.throwAt === stage) throw new Error(`${stage} canary`);
    return value;
  }

  const factories = {
    environment: () => step("environment", environment),
    logger: (actual: unknown) => {
      expect(actual).toBe(environment);
      return step("logger", logger);
    },
    clock: () => step("clock", clock),
    ids: () => step("ids", ids),
    database: (actual: unknown) => {
      expect(actual).toBe(environment);
      return step("database", { database, destroy: destroyDatabase });
    },
    tokenVerifier: (actualEnvironment: unknown, actualClock: unknown) => {
      expect(actualEnvironment).toBe(environment);
      expect(actualClock).toBe(clock);
      return step("tokenVerifier", tokenVerifier);
    },
    webhookVerifier: (actualEnvironment: unknown, actualClock: unknown) => {
      expect(actualEnvironment).toBe(environment);
      expect(actualClock).toBe(clock);
      return step("webhookVerifier", webhookVerifier);
    },
    directory: (actual: unknown) => {
      expect(actual).toBe(environment);
      return step("directory", directory);
    },
    backgroundCredentials: (actual: unknown) => {
      expect(actual).toBe(environment);
      return step("backgroundCredentials", backgroundCredentials);
    },
    pushTokenProtector: (actual: unknown) => {
      expect(actual).toBe(environment);
      return step("pushTokenProtector", { destroy: destroyKms, protector });
    },
    snapshots: (actual: unknown) => {
      expect(actual).toBe(database);
      return step("snapshots", snapshots);
    },
    unitOfWork: (actual: unknown) => {
      expect(actual).toBe(database);
      return step("unitOfWork", unitOfWork);
    },
    identityUnitOfWork: (actual: unknown) => {
      expect(actual).toBe(database);
      return step("identityUnitOfWork", identityUnitOfWork);
    },
    registerDevice: (actual: Record<string, unknown>) => {
      expect(actual).toEqual({
        backgroundCredentials,
        clock,
        directory,
        ids,
        protector,
        snapshots,
        unitOfWork,
      });
      return step("registerDevice", registerDevice);
    },
    updateDevicePushToken: (actual: Record<string, unknown>) => {
      expect(actual).toEqual({ clock, protector, snapshots, unitOfWork });
      return step("updateDevicePushToken", updateDevicePushToken);
    },
    revokeDevice: (actual: Record<string, unknown>) => {
      expect(actual).toEqual({ clock, snapshots, unitOfWork });
      return step("revokeDevice", revokeDevice);
    },
    clerkWebhookService: (actual: Record<string, unknown>) => {
      expect(actual).toEqual({
        clock,
        ids,
        unitOfWork: identityUnitOfWork,
        verifier: webhookVerifier,
      });
      return step("clerkWebhookService", webhookService);
    },
    buildApp: (actual: Record<string, unknown>) => {
      expect(actual).toMatchObject({
        clock,
        devices: {
          registerDevice,
          revokeDevice,
          tokenVerifier,
          updateDevicePushToken,
        },
        environment,
        ids,
        identity: { webhookService },
        logger,
      });
      return step("buildApp", { close, listen });
    },
  } as unknown as ApiRuntimeFactories;

  return { calls, close, destroyDatabase, destroyKms, factories, listen };
}

describe("API runtime", () => {
  it("constructs every singleton once in exact order and preserves identity", async () => {
    const test = createRuntimeHarness();
    const runtime = await createApiRuntime(test.factories);
    expect(test.calls).toEqual(stages);
    await runtime.listen();
    await Promise.all([runtime.close(), runtime.close(), runtime.close()]);
    expect(test.listen).toHaveBeenCalledTimes(1);
    expect(test.close).toHaveBeenCalledTimes(1);
    expect(test.destroyKms).toHaveBeenCalledTimes(1);
    expect(test.destroyDatabase).toHaveBeenCalledTimes(1);
  });

  it.each(stages)(
    "cleans acquired handles when %s construction fails",
    async (throwAt) => {
      const test = createRuntimeHarness({ throwAt });
      await expect(createApiRuntime(test.factories)).rejects.toThrow(
        "CrewRoll API construction failed",
      );
      const position = stages.indexOf(throwAt);
      expect(test.close).toHaveBeenCalledTimes(0);
      expect(test.destroyKms).toHaveBeenCalledTimes(
        position > stages.indexOf("pushTokenProtector") ? 1 : 0,
      );
      expect(test.destroyDatabase).toHaveBeenCalledTimes(
        position > stages.indexOf("database") ? 1 : 0,
      );
    },
  );

  it("listen failure closes every handle once", async () => {
    const test = createRuntimeHarness({ listenFailure: true });
    const runtime = await createApiRuntime(test.factories);
    await expect(runtime.listen()).rejects.toThrow(
      "CrewRoll API listen failed",
    );
    expect(test.close).toHaveBeenCalledTimes(1);
    expect(test.destroyKms).toHaveBeenCalledTimes(1);
    expect(test.destroyDatabase).toHaveBeenCalledTimes(1);
  });

  it.each([
    { appCloseFailure: true },
    { kmsDestroyFailure: true },
    { databaseDestroyFailure: true },
    {
      appCloseFailure: true,
      databaseDestroyFailure: true,
      kmsDestroyFailure: true,
    },
  ])("attempts every cleanup under lifecycle failures %#", async (failures) => {
    const test = createRuntimeHarness(failures);
    const runtime = await createApiRuntime(test.factories);
    await expect(runtime.close()).rejects.toThrow(
      "CrewRoll API lifecycle failed",
    );
    expect(test.close).toHaveBeenCalledTimes(1);
    expect(test.destroyKms).toHaveBeenCalledTimes(1);
    expect(test.destroyDatabase).toHaveBeenCalledTimes(1);
  });

  it("imports production factories and main without network", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("provider network canary"));
    await import("../../src/api/productionApiFactories.js");
    await import("../../src/api/main.js");
    expect(fetch).toHaveBeenCalledTimes(0);
    fetch.mockRestore();
  });
});
