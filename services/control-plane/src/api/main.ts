import { buildApp } from "../app/buildApp.js";
import { loadEnvironment } from "../config/env.js";
import { createDatabase } from "../db/database.js";
import { createSafeLogger } from "../shared/observability/safeLogger.js";

async function startApi(): Promise<void> {
  const environment = loadEnvironment(process.env);
  const logger = createSafeLogger(environment);
  const database = createDatabase(environment.databaseUrl);
  let app: ReturnType<typeof buildApp>;

  try {
    app = buildApp({
      clock: { now: () => new Date() },
      environment,
      ids: { uuid: () => globalThis.crypto.randomUUID() },
      logger,
      readiness: {
        async check() {
          await database
            .selectNoFrom((expressionBuilder) =>
              expressionBuilder.lit(1).as("ready"),
            )
            .executeTakeFirstOrThrow();
        },
      },
    });
  } catch (error) {
    await database.destroy().catch(() => undefined);
    throw error;
  }

  app.addHook("onClose", () => database.destroy());

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= app.close();
    return shutdownPromise;
  };
  const removeSignalHandlers = (): void => {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  };
  const handleSignal = (): void => {
    removeSignalHandlers();
    void shutdown().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    await app.listen({ host: environment.host, port: environment.port });
  } catch (error) {
    removeSignalHandlers();
    await shutdown().catch(() => undefined);
    throw error;
  }
}

void startApi().catch(() => {
  process.stderr.write("CrewRoll API startup failed.\n");
  process.exitCode = 1;
});
