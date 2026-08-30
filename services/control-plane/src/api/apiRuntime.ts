import type { AppDependencies } from "../app/dependencies.js";
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
} from "../modules/identity/index.js";

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

export interface ApiRuntimeFactories {
  backgroundCredentials(environment: Environment): BackgroundCredentialIssuer;
  buildApp(dependencies: AppDependencies): RuntimeApp;
  clock(): Clock;
  clerkWebhookService(
    dependencies: ClerkWebhookServiceDependencies,
  ): ClerkWebhookRouteDependencies["webhookService"];
  database(environment: Environment): DatabaseHandle;
  directory(environment: Environment): ClerkUserDirectory;
  environment(): Environment;
  ids(): IdGenerator;
  identityUnitOfWork(database: unknown): IdentityUnitOfWork;
  logger(environment: Environment): Logger;
  pushTokenProtector(environment: Environment): KmsPushTokenProtectorHandle;
  registerDevice(
    dependencies: RegisterDeviceDependencies,
  ): DeviceRouteDependencies["registerDevice"];
  revokeDevice(
    dependencies: RevokeDeviceDependencies,
  ): DeviceRouteDependencies["revokeDevice"];
  snapshots(database: unknown): DeviceAuthorizationSnapshotReader;
  tokenVerifier(environment: Environment, clock: Clock): ClerkTokenVerifier;
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
    app = factories.buildApp({
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
  } catch {
    await attemptAll([
      ...(app === undefined ? [] : [() => app!.close()]),
      ...(kmsHandle === undefined ? [] : [() => kmsHandle!.destroy()]),
      ...(databaseHandle === undefined
        ? []
        : [() => databaseHandle!.destroy()]),
    ]);
    throw new Error("CrewRoll API construction failed");
  }
}
