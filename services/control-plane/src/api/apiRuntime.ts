import type { AppDependencies } from "../app/dependencies.js";
import { createBackgroundDeviceAuthenticator } from "../modules/devices/index.js";
import type { MediaRouteDependencies } from "../modules/media/index.js";
import type {
  BackgroundCredentialIssuer,
  ClerkTokenVerifier,
  ClerkUserDirectory,
  DeviceAuthorizationSnapshotReader,
  DeviceRouteDependencies,
  DeviceUnitOfWork,
  PushTokenProtector,
  RegisterDeviceDependencies,
  RevokeDeviceDependencies,
  UpdateDevicePushTokenDependencies,
} from "../modules/devices/index.js";
import type {
  ClerkWebhookRouteDependencies,
  ClerkWebhookServiceDependencies,
  ClerkWebhookVerifier,
  IdentityUnitOfWork,
  ProfileRepository,
  ProfileRouteDependencies,
  SyncProfileDependencies,
} from "../modules/identity/index.js";
import type {
  ApproveJoinRequestDependencies,
  CreateTripDependencies,
  ForegroundActorSnapshotReader,
  GetTripDependencies,
  PreviewInviteDependencies,
  InviteCodeCryptography,
  RejectJoinRequestDependencies,
  RequestJoinDependencies,
  ResolveCreateTripOutcomeDependencies,
  ResolveForegroundActor,
  SetTripReadinessDependencies,
  StartTripDependencies,
  TripRouteDependencies,
  TripUnitOfWork,
} from "../modules/trips/index.js";

type Environment = AppDependencies["environment"];
type Logger = AppDependencies["logger"];
type Clock = AppDependencies["clock"];
type IdGenerator = AppDependencies["ids"];

interface DatabaseHandle {
  readonly database: unknown;
  destroy(): Promise<void>;
}

interface RuntimeApp {
  close(): Promise<void>;
  listen(options: {
    readonly host: string;
    readonly port: number;
  }): Promise<unknown>;
}

interface KmsPushTokenProtectorHandle {
  readonly destroy: () => void;
  readonly protector: PushTokenProtector;
}

type ApiConfigurationKey = "INVITE_CODE_HMAC_KEY";

export class ApiConfigurationError extends Error {
  readonly code = "API_CONFIGURATION_ERROR" as const;
  readonly configurationKey: ApiConfigurationKey;

  constructor(configurationKey: ApiConfigurationKey) {
    super(configurationKey);
    this.name = "ApiConfigurationError";
    this.configurationKey = configurationKey;
  }
}

export interface ApiRuntimeFactories {
  tripLifecycle?(
    database: unknown,
    clock: Clock,
  ): NonNullable<TripRouteDependencies["lifecycle"]>;
  syncProfile(
    dependencies: SyncProfileDependencies,
  ): ProfileRouteDependencies["syncProfile"];
  media?(input: {
    database: unknown;
    environment: Environment;
    clock: Clock;
    authenticator: MediaRouteDependencies["authenticator"];
  }): Promise<MediaRouteDependencies | undefined>;
  approveJoinRequest(
    dependencies: ApproveJoinRequestDependencies,
  ): TripRouteDependencies["approveJoinRequest"];
  backgroundCredentials(environment: Environment): BackgroundCredentialIssuer;
  buildApp(dependencies: AppDependencies): RuntimeApp;
  classifyTripConstraint(error: unknown): string | null;
  clock(): Clock;
  clerkWebhookService(
    dependencies: ClerkWebhookServiceDependencies,
  ): ClerkWebhookRouteDependencies["webhookService"];
  database(environment: Environment): DatabaseHandle;
  directory(environment: Environment): ClerkUserDirectory;
  environment(): Environment;
  foregroundTripSnapshots(database: unknown): ForegroundActorSnapshotReader;
  previewInvite(
    dependencies: PreviewInviteDependencies,
  ): TripRouteDependencies["previewInvite"];
  getTrip(dependencies: GetTripDependencies): TripRouteDependencies["getTrip"];
  ids(): IdGenerator;
  identityUnitOfWork(database: unknown): IdentityUnitOfWork & ProfileRepository;
  inviteCodeCryptography(environment: Environment): InviteCodeCryptography;
  logger(environment: Environment): Logger;
  pushTokenProtector(environment: Environment): KmsPushTokenProtectorHandle;
  registerDevice(
    dependencies: RegisterDeviceDependencies,
  ): DeviceRouteDependencies["registerDevice"];
  rejectJoinRequest(
    dependencies: RejectJoinRequestDependencies,
  ): TripRouteDependencies["rejectJoinRequest"];
  requestJoin(
    dependencies: RequestJoinDependencies,
  ): TripRouteDependencies["requestJoin"];
  resolveCreateTripOutcome(
    dependencies: ResolveCreateTripOutcomeDependencies,
  ): TripRouteDependencies["resolveCreateTripOutcome"];
  resolveForegroundActor(
    snapshots: ForegroundActorSnapshotReader,
  ): ResolveForegroundActor;
  revokeDevice(
    dependencies: RevokeDeviceDependencies,
  ): DeviceRouteDependencies["revokeDevice"];
  snapshots(database: unknown): DeviceAuthorizationSnapshotReader;
  setTripReadiness(
    dependencies: SetTripReadinessDependencies,
  ): TripRouteDependencies["setTripReadiness"];
  startTrip(
    dependencies: StartTripDependencies,
  ): TripRouteDependencies["startTrip"];
  tokenVerifier(environment: Environment, clock: Clock): ClerkTokenVerifier;
  createTrip(
    dependencies: CreateTripDependencies,
  ): TripRouteDependencies["createTrip"];
  tripUnitOfWork(database: unknown): TripUnitOfWork;
  unitOfWork(database: unknown): DeviceUnitOfWork;
  updateDevicePushToken(
    dependencies: UpdateDevicePushTokenDependencies,
  ): DeviceRouteDependencies["updateDevicePushToken"];
  webhookVerifier(environment: Environment, clock: Clock): ClerkWebhookVerifier;
}

export interface ApiRuntime {
  close(): Promise<void>;
  listen(): Promise<void>;
}

type ApiSignal = "SIGINT" | "SIGTERM";

export interface ApiSignalTarget {
  exitCode: string | number | null | undefined;
  off(signal: ApiSignal, listener: () => void): unknown;
  once(signal: ApiSignal, listener: () => void): unknown;
}

async function attemptAll(
  actions: readonly (() => unknown)[],
): Promise<boolean> {
  let failed = false;
  for (const action of actions) {
    try {
      await action();
    } catch {
      failed = true;
    }
  }
  return failed;
}

export async function createApiRuntime(
  factories: ApiRuntimeFactories,
): Promise<ApiRuntime> {
  let databaseHandle: DatabaseHandle | undefined;
  let kmsHandle: KmsPushTokenProtectorHandle | undefined;
  let app: RuntimeApp | undefined;
  try {
    const environment = factories.environment();
    const logger = factories.logger(environment);
    const clock = factories.clock();
    const ids = factories.ids();
    databaseHandle = factories.database(environment);
    const tokenVerifier = factories.tokenVerifier(environment, clock);
    const webhookVerifier = factories.webhookVerifier(environment, clock);
    const directory = factories.directory(environment);
    const backgroundCredentials = factories.backgroundCredentials(environment);
    kmsHandle = factories.pushTokenProtector(environment);
    const snapshots = factories.snapshots(databaseHandle.database);
    const unitOfWork = factories.unitOfWork(databaseHandle.database);
    const identityUnitOfWork = factories.identityUnitOfWork(
      databaseHandle.database,
    );
    const inviteCodeCryptography =
      factories.inviteCodeCryptography(environment);
    const foregroundTripSnapshots = factories.foregroundTripSnapshots(
      databaseHandle.database,
    );
    const tripUnitOfWork = factories.tripUnitOfWork(databaseHandle.database);
    const resolveForegroundActor = factories.resolveForegroundActor(
      foregroundTripSnapshots,
    );
    const registerDevice = factories.registerDevice({
      backgroundCredentials,
      clock,
      directory,
      ids,
      protector: kmsHandle.protector,
      snapshots,
      unitOfWork,
    });
    const updateDevicePushToken = factories.updateDevicePushToken({
      clock,
      protector: kmsHandle.protector,
      snapshots,
      unitOfWork,
    });
    const revokeDevice = factories.revokeDevice({
      clock,
      snapshots,
      unitOfWork,
    });
    const webhookService = factories.clerkWebhookService({
      clock,
      ids,
      unitOfWork: identityUnitOfWork,
      verifier: webhookVerifier,
    });
    const tripServiceDependencies = {
      classifyConstraint: (error: unknown) =>
        factories.classifyTripConstraint(error),
      ids,
      unitOfWork: tripUnitOfWork,
    };
    const createTrip = factories.createTrip({
      ...tripServiceDependencies,
      hasher: inviteCodeCryptography,
    });
    const resolveCreateTripOutcome = factories.resolveCreateTripOutcome({
      unitOfWork: tripUnitOfWork,
    });
    const requestJoin = factories.requestJoin({
      ...tripServiceDependencies,
      hasher: inviteCodeCryptography,
    });
    const approveJoinRequest = factories.approveJoinRequest(
      tripServiceDependencies,
    );
    const rejectJoinRequest = factories.rejectJoinRequest(
      tripServiceDependencies,
    );
    const setTripReadiness = factories.setTripReadiness(
      tripServiceDependencies,
    );
    const startTrip = factories.startTrip(tripServiceDependencies);
    const getTrip = factories.getTrip({ unitOfWork: tripUnitOfWork });
    const previewInvite = factories.previewInvite({
      unitOfWork: tripUnitOfWork,
      hasher: inviteCodeCryptography,
    });
    const media = await factories.media?.({
      database: databaseHandle.database,
      environment,
      clock,
      authenticator: createBackgroundDeviceAuthenticator({ clock, unitOfWork }),
    });
    const lifecycle = factories.tripLifecycle?.(databaseHandle.database, clock);
    app = factories.buildApp({
      ...(media
        ? { media: { ...media, ...(lifecycle ? { lifecycle } : {}) } }
        : {}),
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
      profile: {
        tokenVerifier,
        syncProfile: factories.syncProfile({
          directory,
          repository: identityUnitOfWork,
          clock,
          ids,
        }),
      },
      logger,
      readiness: {
        async check() {
          const database = databaseHandle?.database as {
            selectNoFrom(
              callback: (builder: { lit(value: number): unknown }) => unknown,
            ): {
              executeTakeFirstOrThrow(): Promise<unknown>;
            };
          };
          await database
            .selectNoFrom((builder) => builder.lit(1))
            .executeTakeFirstOrThrow();
        },
      },
      trips: {
        ...(lifecycle ? { lifecycle } : {}),
        approveJoinRequest,
        createTrip,
        getTrip,
        previewInvite,
        rejectJoinRequest,
        requestJoin,
        resolveCreateTripOutcome,
        resolveForegroundActor,
        setTripReadiness,
        startTrip,
        tokenVerifier,
      },
    });

    let closePromise: Promise<void> | undefined;
    let listenPromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        const failed = await attemptAll([
          () => app!.close(),
          () => kmsHandle!.destroy(),
          () => databaseHandle!.destroy(),
        ]);
        if (failed) throw new Error("CrewRoll API lifecycle failed");
      })();
      return closePromise;
    };
    return {
      close,
      listen() {
        listenPromise ??= (async () => {
          try {
            await app!.listen({
              host: environment.host,
              port: environment.port,
            });
          } catch {
            await close().catch(() => undefined);
            throw new Error("CrewRoll API listen failed");
          }
        })();
        return listenPromise;
      },
    };
  } catch (error) {
    await attemptAll([
      ...(app === undefined ? [] : [() => app!.close()]),
      ...(kmsHandle === undefined ? [] : [() => kmsHandle!.destroy()]),
      ...(databaseHandle === undefined
        ? []
        : [() => databaseHandle!.destroy()]),
    ]);
    if (error instanceof ApiConfigurationError) throw error;
    throw new Error("CrewRoll API construction failed", { cause: error });
  }
}

export async function runApi(
  factories: ApiRuntimeFactories,
  signalTarget: ApiSignalTarget = process,
): Promise<ApiRuntime> {
  const runtime = await createApiRuntime(factories);
  let sigintInstalled = false;
  let sigtermInstalled = false;
  let listenersRemoved = false;
  const removeListeners = (): void => {
    if (listenersRemoved) return;
    listenersRemoved = true;
    if (sigintInstalled) signalTarget.off("SIGINT", shutdown);
    if (sigtermInstalled) signalTarget.off("SIGTERM", shutdown);
  };
  const close = (): Promise<void> => {
    removeListeners();
    return runtime.close();
  };
  function shutdown(): void {
    void close().then(
      () => {
        signalTarget.exitCode = 0;
      },
      () => {
        signalTarget.exitCode = 1;
      },
    );
  }

  try {
    signalTarget.once("SIGINT", shutdown);
    sigintInstalled = true;
    signalTarget.once("SIGTERM", shutdown);
    sigtermInstalled = true;
  } catch {
    removeListeners();
    await runtime.close().catch(() => undefined);
    throw new Error("CrewRoll API signal setup failed");
  }

  try {
    await runtime.listen();
  } catch (error) {
    removeListeners();
    throw error;
  }
  return { close, listen: () => runtime.listen() };
}
