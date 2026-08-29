import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../services/control-plane/src/db/database.js";
import { migrateToLatest } from "../../services/control-plane/src/db/migrate.js";
import { startMigratedPostgres } from "./support/postgres.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const secretCanary = "bootstrap-secret-canary-8e90ad";

interface BootstrapDatabase {
  readonly connectionUri: string;
  stop(): Promise<void>;
}

function isApprovedLoopbackDatabase(connectionUri: string): boolean {
  try {
    const url = new URL(connectionUri);
    return (
      url.protocol === "postgresql:" &&
      url.username === "uankit" &&
      url.password === "" &&
      url.hostname === "127.0.0.1" &&
      url.port === "55432" &&
      url.pathname === "/crewroll_codex_api_20260829" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

async function startBootstrapDatabase(): Promise<BootstrapDatabase> {
  const loopbackUri = process.env.CREWROLL_API_LOOPBACK_DATABASE_URL;
  if (loopbackUri === undefined) {
    const context = await startMigratedPostgres();
    if (context.container === undefined) {
      await context.stop();
      throw new Error(
        "Expected a Testcontainers-backed API bootstrap database",
      );
    }
    return {
      connectionUri: context.container.getConnectionUri(),
      stop: () => context.stop(),
    };
  }

  if (
    process.env.CREWROLL_API_ALLOW_LOOPBACK_POSTGRES !== "1" ||
    !isApprovedLoopbackDatabase(loopbackUri)
  ) {
    throw new Error("Unapproved CrewRoll API loopback database configuration");
  }

  const database = createDatabase(loopbackUri);
  try {
    await migrateToLatest(database);
  } catch (error) {
    await database.destroy();
    throw error;
  }
  return {
    connectionUri: loopbackUri,
    stop: () => database.destroy(),
  };
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  return address.port;
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("CrewRoll API child did not exit before the deadline"));
    }, timeoutMs);
    timeout.unref();

    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      clearTimeout(timeout);
      resolve({ code, signal });
    }

    child.once("exit", onExit);
  });
}

async function waitForReady(
  child: ChildProcess,
  baseUrl: string,
): Promise<Response> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("CrewRoll API child exited before readiness");
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return response;
    } catch {
      // The bounded readiness loop owns connection-startup retries.
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 100);
      timeout.unref();
    });
  }
  throw new Error("CrewRoll API did not become ready before the deadline");
}

describe.sequential("API bootstrap", () => {
  let postgres: BootstrapDatabase;

  beforeAll(async () => {
    postgres = await startBootstrapDatabase();
  });

  afterAll(async () => {
    await postgres?.stop();
  });

  it("serves physical health checks and exits cleanly on SIGTERM", async () => {
    const port = await allocateLoopbackPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      ["services/control-plane/dist/src/api/main.js"],
      {
        cwd: repositoryRoot,
        env: {
          CLERK_SECRET_KEY: secretCanary,
          DATABASE_URL: postgres.connectionUri,
          HOST: "127.0.0.1",
          LOG_LEVEL: "trace",
          NODE_ENV: "test",
          PORT: String(port),
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      const ready = await waitForReady(child, baseUrl);
      const live = await fetch(`${baseUrl}/health/live`, {
        headers: { "X-Request-Id": secretCanary },
      });
      const documentation = await fetch(`${baseUrl}/documentation/`);
      const productRoute = await fetch(`${baseUrl}/v1/trips`);

      expect(await ready.json()).toEqual({ status: "ready" });
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: "ok" });
      expect(live.headers.get("x-request-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      );
      expect(live.headers.get("x-request-id")).not.toBe(secretCanary);
      expect(live.headers.get("x-content-type-options")).toBe("nosniff");
      expect(documentation.status).toBe(200);
      expect(productRoute.status).toBe(404);

      expect(child.kill("SIGTERM")).toBe(true);
      await expect(waitForExit(child, 10_000)).resolves.toEqual({
        code: 0,
        signal: null,
      });

      const serializedLogs = `${stdout}\n${stderr}`;
      expect(serializedLogs).not.toContain(secretCanary);
      expect(serializedLogs).not.toContain(postgres.connectionUri);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child, 5_000);
      }
    }
  });
});
