import { createWorkerRequestRuntime } from "./requestRuntime.js";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    let runtime:
      Awaited<ReturnType<typeof createWorkerRequestRuntime>> | undefined;
    try {
      runtime = await createWorkerRequestRuntime(
        env,
        env.DATABASE.connectionString,
        env.PUBLIC_API_ORIGIN,
      );
      return await runtime.fetch(request, ctx);
    } catch {
      // Never log raw errors: upstream errors can contain signed URLs or tokens.
      console.error(JSON.stringify({ event: "api_runtime_failed" }));
      return Response.json(
        { error: "Service temporarily unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    } finally {
      // Route handlers finish all database mutations before sending their reply.
      // R2 download bodies remain streamed and do not depend on the DB pool.
      if (runtime) ctx.waitUntil(runtime.close());
    }
  },
  async scheduled(_controller, env): Promise<void> {
    const runtime = await createWorkerRequestRuntime(
      env,
      env.DATABASE.connectionString,
      env.PUBLIC_API_ORIGIN,
    );
    try {
      await runtime.cleanup();
      console.log(JSON.stringify({ event: "media_cleanup_completed" }));
    } catch {
      console.error(JSON.stringify({ event: "media_cleanup_failed" }));
      throw new Error("Media cleanup failed");
    } finally {
      await runtime.close();
    }
  },
} satisfies ExportedHandler<Env>;
