import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { validRegisterDeviceBody } from "@crewroll/contracts/fixtures/http";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiConfigurationError,
  createApiRuntime,
  runApi,
  type ApiRuntimeFactories,
} from "../../src/api/apiRuntime.js";
import { productionApiFactories } from "../../src/api/productionApiFactories.js";
import {
  createDeviceTestHarness,
  fixedDeviceId,
} from "../support/deviceFakes.js";
import { createTestDependencies } from "../support/fakes.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const clerkSubject = "user_clerk_subject";
const registrationKey = "018f0d98-76fa-7d1a-b4b4-1f742c2e3170";
const commandKey = "018f0d98-76fa-7d1a-b4b4-1f742c2e3171";

afterEach(() => {
  vi.useRealTimers();
});

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
  "inviteCodeCryptography",
  "foregroundTripSnapshots",
  "tripUnitOfWork",
  "resolveForegroundActor",
  "registerDevice",
  "updateDevicePushToken",
  "revokeDevice",
  "clerkWebhookService",
  "createTrip",
  "resolveCreateTripOutcome",
  "requestJoin",
  "approveJoinRequest",
  "rejectJoinRequest",
  "setTripReadiness",
  "startTrip",
  "getTrip",
  "previewInvite",
  "buildApp",
] as const;
type Stage = (typeof stages)[number];

function createRuntimeHarness(
  options: {
    readonly appCloseFailure?: boolean;
    readonly databaseDestroyFailure?: boolean;
    readonly kmsDestroyFailure?: boolean;
    readonly listenFailure?: boolean;
    readonly inviteConfigurationFailure?: boolean;
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
  const inviteCodeCryptography = { slot: "inviteCodeCryptography" };
  const foregroundTripSnapshots = { slot: "foregroundTripSnapshots" };
  const tripUnitOfWork = { slot: "tripUnitOfWork" };
  const resolveForegroundActor = { slot: "resolveForegroundActor" };
  const registerDevice = { slot: "registerDevice" };
  const updateDevicePushToken = { slot: "updateDevicePushToken" };
  const revokeDevice = { slot: "revokeDevice" };
  const webhookService = { slot: "webhookService" };
  const createTrip = { slot: "createTrip" };
  const resolveCreateTripOutcome = { slot: "resolveCreateTripOutcome" };
  const requestJoin = { slot: "requestJoin" };
  const approveJoinRequest = { slot: "approveJoinRequest" };
  const rejectJoinRequest = { slot: "rejectJoinRequest" };
  const setTripReadiness = { slot: "setTripReadiness" };
  const startTrip = { slot: "startTrip" };
  const getTrip = { slot: "getTrip" };
  const previewInvite = { slot: "previewInvite" };
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
    inviteCodeCryptography: (actual: unknown) => {
      expect(actual).toBe(environment);
      calls.push("inviteCodeCryptography");
      if (options.inviteConfigurationFailure) {
        throw new ApiConfigurationError("INVITE_CODE_HMAC_KEY");
      }
      if (options.throwAt === "inviteCodeCryptography") {
        throw new Error("inviteCodeCryptography canary");
      }
      return inviteCodeCryptography;
    },
    foregroundTripSnapshots: (actual: unknown) => {
      expect(actual).toBe(database);
      return step("foregroundTripSnapshots", foregroundTripSnapshots);
    },
    tripUnitOfWork: (actual: unknown) => {
      expect(actual).toBe(database);
      return step("tripUnitOfWork", tripUnitOfWork);
    },
    resolveForegroundActor: (actual: unknown) => {
      expect(actual).toBe(foregroundTripSnapshots);
      return step("resolveForegroundActor", resolveForegroundActor);
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
    classifyTripConstraint: vi.fn(() => null),
    createTrip: (actual: Record<string, unknown>) => {
      expect(typeof actual.classifyConstraint).toBe("function");
      expect(actual).toEqual({
        classifyConstraint: actual.classifyConstraint,
        hasher: inviteCodeCryptography,
        ids,
        unitOfWork: tripUnitOfWork,
      });
      return step("createTrip", createTrip);
    },
    resolveCreateTripOutcome: (actual: Record<string, unknown>) => {
      expect(actual).toEqual({ unitOfWork: tripUnitOfWork });
      return step("resolveCreateTripOutcome", resolveCreateTripOutcome);
    },
    requestJoin: (actual: Record<string, unknown>) => {
      expect(typeof actual.classifyConstraint).toBe("function");
      expect(actual).toEqual({
        classifyConstraint: actual.classifyConstraint,
        hasher: inviteCodeCryptography,
        ids,
        unitOfWork: tripUnitOfWork,
      });
      return step("requestJoin", requestJoin);
    },
    approveJoinRequest: (actual: Record<string, unknown>) => {
      expect(typeof actual.classifyConstraint).toBe("function");
      expect(actual).toEqual({
        classifyConstraint: actual.classifyConstraint,
        ids,
        unitOfWork: tripUnitOfWork,
      });
      return step("approveJoinRequest", approveJoinRequest);
    },
    rejectJoinRequest: (actual: Record<string, unknown>) => {
      expect(typeof actual.classifyConstraint).toBe("function");
      expect(actual).toEqual({
        classifyConstraint: actual.classifyConstraint,
        ids,
        unitOfWork: tripUnitOfWork,
      });
      return step("rejectJoinRequest", rejectJoinRequest);
    },
    setTripReadiness: (actual: Record<string, unknown>) => {
      expect(typeof actual.classifyConstraint).toBe("function");
      expect(actual).toEqual({
        classifyConstraint: actual.classifyConstraint,
        ids,
        unitOfWork: tripUnitOfWork,
      });
      return step("setTripReadiness", setTripReadiness);
    },
    startTrip: (actual: Record<string, unknown>) => {
      expect(typeof actual.classifyConstraint).toBe("function");
      expect(actual).toEqual({
        classifyConstraint: actual.classifyConstraint,
        ids,
        unitOfWork: tripUnitOfWork,
      });
      return step("startTrip", startTrip);
    },
    previewInvite: (actual: Record<string, unknown>) => {
      expect(actual).toEqual({
        unitOfWork: tripUnitOfWork,
        hasher: inviteCodeCryptography,
      });
      return step("previewInvite", previewInvite);
    },
    getTrip: (actual: Record<string, unknown>) => {
      expect(actual).toEqual({ unitOfWork: tripUnitOfWork });
      return step("getTrip", getTrip);
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
        trips: {
          approveJoinRequest,
          createTrip,
          getTrip,
          rejectJoinRequest,
          requestJoin,
          resolveCreateTripOutcome,
          resolveForegroundActor,
          setTripReadiness,
          startTrip,
          tokenVerifier,
        },
      });
      return step("buildApp", { close, listen });
    },
  } as unknown as ApiRuntimeFactories;

  return { calls, close, destroyDatabase, destroyKms, factories, listen };
}

type ApiSignal = "SIGINT" | "SIGTERM";

function createSignalHarness(failOn?: ApiSignal) {
  const listeners = new Map<ApiSignal, Set<() => void>>([
    ["SIGINT", new Set()],
    ["SIGTERM", new Set()],
  ]);
  const signals = {
    exitCode: undefined as number | undefined,
    off: vi.fn((signal: ApiSignal, listener: () => void) => {
      listeners.get(signal)!.delete(listener);
      return signals;
    }),
    once: vi.fn((signal: ApiSignal, listener: () => void) => {
      if (signal === failOn) throw new Error("signal install canary");
      listeners.get(signal)!.add(listener);
      return signals;
    }),
  };
  return {
    emit(signal: ApiSignal) {
      for (const listener of [...listeners.get(signal)!]) listener();
    },
    listenerCount(signal: ApiSignal) {
      return listeners.get(signal)!.size;
    },
    signals,
  };
}

describe("API runtime", () => {
  it.each(["registration", "PATCH", "DELETE"] as const)(
    "uses a whole-second production clock for %s orchestration",
    async (operation) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-30T00:00:00.123Z"));
      const test = createDeviceTestHarness();
      const clock = productionApiFactories.clock();

      if (operation === "registration") {
        await expect(
          productionApiFactories
            .registerDevice({ ...test.dependencies, clock })
            .execute({
              body: validRegisterDeviceBody(),
              clerkSubject,
              idempotencyKey: registrationKey,
            }),
        ).resolves.toMatchObject({ deviceId: fixedDeviceId });
      } else {
        await productionApiFactories.registerDevice(test.dependencies).execute({
          body: validRegisterDeviceBody(),
          clerkSubject,
          idempotencyKey: registrationKey,
        });
        if (operation === "PATCH") {
          await expect(
            productionApiFactories
              .updateDevicePushToken({ ...test.dependencies, clock })
              .execute({
                body: { appVersion: "1.0.1", pushToken: null },
                clerkSubject,
                deviceId: fixedDeviceId,
                headerDeviceId: fixedDeviceId,
                idempotencyKey: commandKey,
              }),
          ).resolves.toBeUndefined();
        } else {
          await expect(
            productionApiFactories
              .revokeDevice({ ...test.dependencies, clock })
              .execute({
                clerkSubject,
                deviceId: fixedDeviceId,
                headerDeviceId: fixedDeviceId,
                idempotencyKey: commandKey,
              }),
          ).resolves.toBeUndefined();
        }
      }

      expect(clock.now().getMilliseconds()).toBe(0);
    },
  );

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

  it("runApi installs signals and removes them on programmatic close", async () => {
    const test = createRuntimeHarness();
    const signal = createSignalHarness();
    const runtime = await runApi(test.factories, signal.signals);

    expect(signal.listenerCount("SIGINT")).toBe(1);
    expect(signal.listenerCount("SIGTERM")).toBe(1);
    await Promise.all([runtime.close(), runtime.close()]);

    expect(signal.listenerCount("SIGINT")).toBe(0);
    expect(signal.listenerCount("SIGTERM")).toBe(0);
    expect(signal.signals.off).toHaveBeenCalledTimes(2);
    expect(test.close).toHaveBeenCalledTimes(1);
    expect(test.destroyKms).toHaveBeenCalledTimes(1);
    expect(test.destroyDatabase).toHaveBeenCalledTimes(1);
  });

  it("runApi removes signals and all handles on listen failure", async () => {
    const test = createRuntimeHarness({ listenFailure: true });
    const signal = createSignalHarness();

    await expect(runApi(test.factories, signal.signals)).rejects.toThrow(
      "CrewRoll API listen failed",
    );

    expect(signal.listenerCount("SIGINT")).toBe(0);
    expect(signal.listenerCount("SIGTERM")).toBe(0);
    expect(test.close).toHaveBeenCalledTimes(1);
    expect(test.destroyKms).toHaveBeenCalledTimes(1);
    expect(test.destroyDatabase).toHaveBeenCalledTimes(1);
  });

  it("runApi removes a partially installed signal and closes on setup failure", async () => {
    const test = createRuntimeHarness();
    const signal = createSignalHarness("SIGTERM");

    await expect(runApi(test.factories, signal.signals)).rejects.toThrow(
      "CrewRoll API signal setup failed",
    );

    expect(signal.listenerCount("SIGINT")).toBe(0);
    expect(signal.listenerCount("SIGTERM")).toBe(0);
    expect(test.listen).toHaveBeenCalledTimes(0);
    expect(test.close).toHaveBeenCalledTimes(1);
    expect(test.destroyKms).toHaveBeenCalledTimes(1);
    expect(test.destroyDatabase).toHaveBeenCalledTimes(1);
  });

  it("competing signals share one close and remove both listeners", async () => {
    const test = createRuntimeHarness();
    const signal = createSignalHarness();
    const runtime = await runApi(test.factories, signal.signals);

    signal.emit("SIGINT");
    signal.emit("SIGTERM");
    await runtime.close();

    expect(signal.listenerCount("SIGINT")).toBe(0);
    expect(signal.listenerCount("SIGTERM")).toBe(0);
    expect(test.close).toHaveBeenCalledTimes(1);
    expect(test.destroyKms).toHaveBeenCalledTimes(1);
    expect(test.destroyDatabase).toHaveBeenCalledTimes(1);
    expect(signal.signals.exitCode).toBe(0);
  });

  it("isolates listener cleanup across repeated starts", async () => {
    const first = createRuntimeHarness();
    const second = createRuntimeHarness();
    const signal = createSignalHarness();
    const firstRuntime = await runApi(first.factories, signal.signals);
    const secondRuntime = await runApi(second.factories, signal.signals);

    expect(signal.listenerCount("SIGINT")).toBe(2);
    expect(signal.listenerCount("SIGTERM")).toBe(2);
    await firstRuntime.close();
    expect(signal.listenerCount("SIGINT")).toBe(1);
    expect(signal.listenerCount("SIGTERM")).toBe(1);
    signal.emit("SIGTERM");
    await secondRuntime.close();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(signal.listenerCount("SIGINT")).toBe(0);
    expect(signal.listenerCount("SIGTERM")).toBe(0);
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

  it("preserves a tagged key-name-only invite configuration error through failing cleanup", async () => {
    const test = createRuntimeHarness({
      databaseDestroyFailure: true,
      inviteConfigurationFailure: true,
      kmsDestroyFailure: true,
    });

    let thrown: unknown;
    try {
      await createApiRuntime(test.factories);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiConfigurationError);
    expect(thrown).toMatchObject({
      code: "API_CONFIGURATION_ERROR",
      configurationKey: "INVITE_CODE_HMAC_KEY",
      message: "INVITE_CODE_HMAC_KEY",
      name: "ApiConfigurationError",
    });
    expect(String(thrown)).toBe("ApiConfigurationError: INVITE_CODE_HMAC_KEY");
    expect(test.destroyKms).toHaveBeenCalledTimes(1);
    expect(test.destroyDatabase).toHaveBeenCalledTimes(1);
    expect(test.close).toHaveBeenCalledTimes(0);
  });

  it("tags the production invite HMAC construction failure without config values", () => {
    const environment = createTestDependencies().dependencies.environment;
    expect(() =>
      productionApiFactories.inviteCodeCryptography({
        ...environment,
        inviteCodeHmacKey: undefined,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "API_CONFIGURATION_ERROR",
        configurationKey: "INVITE_CODE_HMAC_KEY",
        message: "INVITE_CODE_HMAC_KEY",
      }),
    );
  });

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

  it("fresh-imports production factories and main without construction or network", async () => {
    const factoriesUrl = new URL(
      "../../src/api/productionApiFactories.ts",
      import.meta.url,
    ).href;
    const mainUrl = new URL("../../src/api/main.ts", import.meta.url).href;
    const script = `
      import http from "node:http";
      import https from "node:https";
      import net from "node:net";
      import tls from "node:tls";
      let networkCalls = 0;
      const forbidden = () => {
        networkCalls += 1;
        throw new Error("fresh import attempted network or construction");
      };
      globalThis.fetch = forbidden;
      http.request = forbidden;
      https.request = forbidden;
      net.connect = forbidden;
      tls.connect = forbidden;
      await import(${JSON.stringify(factoriesUrl)});
      await import(${JSON.stringify(mainUrl)});
      if (networkCalls !== 0) throw new Error("fresh import made a network call");
      process.stdout.write("fresh-import-ok");
    `;
    const { stderr, stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { PATH: process.env.PATH ?? "" },
      },
    );
    expect(stdout).toBe("fresh-import-ok");
    expect(stderr).toBe("");
  });
});
