import { buildApp } from "../app/buildApp.js";
import { loadEnvironment, type Environment } from "../config/env.js";
import { createDatabase } from "../db/database.js";
import { createKyselyDeviceAuthorizationSnapshotReader } from "../db/devices/kyselyDeviceAuthorizationSnapshotReader.js";
import { createKyselyDeviceUnitOfWork } from "../db/devices/kyselyDeviceUnitOfWork.js";
import {
  createRegisterDevice,
  createRevokeDevice,
  createUpdateDevicePushToken,
} from "../modules/devices/index.js";
import { createClerkUserDirectory } from "../platform/clerk/clerkUserDirectory.js";
import { createRemoteJoseClerkTokenVerifier } from "../platform/clerk/joseClerkTokenVerifier.js";
import { createHmacBackgroundCredentialIssuer } from "../platform/crypto/hmacBackgroundCredentialIssuer.js";
import { createKmsPushTokenProtector } from "../platform/kms/kmsPushTokenProtector.js";
import { createSafeLogger } from "../shared/observability/safeLogger.js";
import { createApiRuntime, type ApiRuntimeFactories } from "./apiRuntime.js";

function required<Value>(value: Value | undefined): Value {
  if (value === undefined)
    throw new Error("Production configuration unavailable");
  return value;
}

function databaseHandle(environment: Environment) {
  const database = createDatabase(environment.databaseUrl);
  return { database, destroy: () => database.destroy() };
}

export const productionApiFactories: ApiRuntimeFactories = {
  backgroundCredentials: (environment) =>
    createHmacBackgroundCredentialIssuer(
      required(environment.backgroundCredentialHmacKeyV1),
    ),
  buildApp,
  clock: () => ({ now: () => new Date() }),
  database: databaseHandle,
  directory: (environment) =>
    createClerkUserDirectory({
      secretKey: required(environment.clerkSecretKey),
    }),
  environment: () => loadEnvironment(process.env),
  ids: () => ({ uuid: () => globalThis.crypto.randomUUID() }),
  logger: createSafeLogger,
  pushTokenProtector: (environment) =>
    createKmsPushTokenProtector({
      keyId: required(environment.kmsPushTokenKeyId),
      region: required(environment.awsRegion),
    }),
  registerDevice: createRegisterDevice,
  revokeDevice: createRevokeDevice,
  snapshots: (database) =>
    createKyselyDeviceAuthorizationSnapshotReader(
      database as Parameters<
        typeof createKyselyDeviceAuthorizationSnapshotReader
      >[0],
    ),
  tokenVerifier: (environment, clock) =>
    createRemoteJoseClerkTokenVerifier({
      authorizedParties: environment.clerkAuthorizedParties,
      clock,
      issuer: required(environment.clerkIssuer),
    }),
  unitOfWork: (database) =>
    createKyselyDeviceUnitOfWork(
      database as Parameters<typeof createKyselyDeviceUnitOfWork>[0],
    ),
  updateDevicePushToken: createUpdateDevicePushToken,
};

export async function startProductionApi() {
  const runtime = await createApiRuntime(productionApiFactories);
  const shutdown = (): void => {
    void runtime.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await runtime.listen();
  return runtime;
}
