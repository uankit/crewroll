import { createKyselyTripLifecycle } from "../db/trips/kyselyTripLifecycle.js";
import { buildApp } from "../app/buildApp.js";
import { loadEnvironment, type Environment } from "../config/env.js";
import { createDatabase } from "../db/database.js";
import { createKyselyMediaService } from "../db/media/kyselyMediaService.js";
import { createFileCiphertextStore } from "../platform/localMedia/fileCiphertextStore.js";
import { createLocalPushTokenProtector } from "../platform/localMedia/localPushTokenProtector.js";
import { createKyselyDeviceAuthorizationSnapshotReader } from "../db/devices/kyselyDeviceAuthorizationSnapshotReader.js";
import { createKyselyDeviceUnitOfWork } from "../db/devices/kyselyDeviceUnitOfWork.js";
import { createKyselyIdentityUnitOfWork } from "../db/identity/kyselyIdentityUnitOfWork.js";
import { classifyTripConstraint } from "../db/trips/constraintClassifier.js";
import { createKyselyForegroundActorSnapshotReader } from "../db/trips/kyselyForegroundActorSnapshotReader.js";
import { createKyselyTripUnitOfWork } from "../db/trips/kyselyTripUnitOfWork.js";
import {
  createRegisterDevice,
  createRevokeDevice,
  createUpdateDevicePushToken,
} from "../modules/devices/index.js";
import {
  createClerkWebhookService,
  createSyncProfile,
} from "../modules/identity/index.js";
import {
  createApproveJoinRequest,
  createCreateTrip,
  createGetTrip,
  createPreviewInvite,
  createRejectJoinRequest,
  createRequestJoin,
  createResolveCreateTripOutcome,
  createResolveForegroundActor,
  createSetTripReadiness,
  createStartTrip,
} from "../modules/trips/index.js";
import { createClerkUserDirectory } from "../platform/clerk/clerkUserDirectory.js";
import { createRemoteJoseClerkTokenVerifier } from "../platform/clerk/joseClerkTokenVerifier.js";
import { createClerkWebhookVerifier } from "../platform/clerk/verifyClerkWebhook.js";
import { createHmacBackgroundCredentialIssuer } from "../platform/crypto/hmacBackgroundCredentialIssuer.js";
import { createHmacInviteCodeHasher } from "../platform/crypto/hmacInviteCodeHasher.js";
import { createKmsPushTokenProtector } from "../platform/kms/kmsPushTokenProtector.js";
import { createSafeLogger } from "../shared/observability/safeLogger.js";
import {
  ApiConfigurationError,
  type ApiRuntimeFactories,
} from "./apiRuntime.js";

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
  tripLifecycle: (database, clock) =>
    createKyselyTripLifecycle(
      database as Parameters<typeof createKyselyTripLifecycle>[0],
      clock,
    ),
  syncProfile: createSyncProfile,
  async media({ database, environment, clock, authenticator }) {
    if (!environment.localMediaOrigin) return undefined;
    const local = await createFileCiphertextStore({
      directory: required(environment.localMediaDirectory),
      origin: environment.localMediaOrigin,
      signingKey: required(environment.backgroundCredentialHmacKeyV1),
      nodeEnvironment: environment.nodeEnvironment,
      now: () => clock.now(),
    });
    return {
      authenticator,
      localObjects: local.gateway,
      service: createKyselyMediaService(
        database as Parameters<typeof createKyselyMediaService>[0],
        local.store,
        clock,
      ),
    };
  },
  approveJoinRequest: createApproveJoinRequest,
  backgroundCredentials: (environment) =>
    createHmacBackgroundCredentialIssuer(
      required(environment.backgroundCredentialHmacKeyV1),
    ),
  buildApp,
  classifyTripConstraint,
  clock: () => ({
    now: () => new Date(Math.floor(Date.now() / 1_000) * 1_000),
  }),
  clerkWebhookService: createClerkWebhookService,
  database: databaseHandle,
  directory: (environment) =>
    createClerkUserDirectory({
      secretKey: required(environment.clerkSecretKey),
    }),
  environment: () => loadEnvironment(process.env),
  foregroundTripSnapshots: (database) =>
    createKyselyForegroundActorSnapshotReader(
      database as Parameters<
        typeof createKyselyForegroundActorSnapshotReader
      >[0],
    ),
  getTrip: createGetTrip,
  previewInvite: createPreviewInvite,
  ids: () => ({ uuid: () => crypto.randomUUID() }),
  identityUnitOfWork: (database) =>
    createKyselyIdentityUnitOfWork(
      database as Parameters<typeof createKyselyIdentityUnitOfWork>[0],
    ),
  inviteCodeCryptography: (environment) => {
    const key = environment.inviteCodeHmacKey;
    if (key === undefined || key.trim().length === 0) {
      throw new ApiConfigurationError("INVITE_CODE_HMAC_KEY");
    }
    return createHmacInviteCodeHasher(key);
  },
  logger: createSafeLogger,
  pushTokenProtector: (environment) =>
    environment.localMediaOrigin
      ? createLocalPushTokenProtector(
          required(environment.backgroundCredentialHmacKeyV1),
          environment.nodeEnvironment,
        )
      : createKmsPushTokenProtector({
          keyId: required(environment.kmsPushTokenKeyId),
          region: required(environment.awsRegion),
        }),
  registerDevice: createRegisterDevice,
  rejectJoinRequest: createRejectJoinRequest,
  requestJoin: createRequestJoin,
  resolveCreateTripOutcome: createResolveCreateTripOutcome,
  resolveForegroundActor: createResolveForegroundActor,
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
  createTrip: createCreateTrip,
  setTripReadiness: createSetTripReadiness,
  startTrip: createStartTrip,
  tripUnitOfWork: (database) =>
    createKyselyTripUnitOfWork(
      database as Parameters<typeof createKyselyTripUnitOfWork>[0],
    ),
  unitOfWork: (database) =>
    createKyselyDeviceUnitOfWork(
      database as Parameters<typeof createKyselyDeviceUnitOfWork>[0],
    ),
  updateDevicePushToken: createUpdateDevicePushToken,
  webhookVerifier: (environment, clock) =>
    createClerkWebhookVerifier({
      clock,
      signingSecret: required(environment.clerkWebhookSecret),
    }),
};
