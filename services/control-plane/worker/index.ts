import { createWorkerRequestRuntime } from "./requestRuntime.js";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    let dispatch = false;
    let runtime:
      Awaited<ReturnType<typeof createWorkerRequestRuntime>> | undefined;
    try {
      runtime = await createWorkerRequestRuntime(
        env,
        env.DATABASE.connectionString,
        env.PUBLIC_API_ORIGIN,
      );
      const response = await runtime.fetch(request, ctx);
      dispatch =
        response.ok &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
        /^\/v1\/(?:trips(?:\/|$)|assets\/[^/]+\/commit$)/.test(
          new URL(request.url).pathname,
        );
      return response;
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
      if (runtime) {
        const owned = runtime;
        ctx.waitUntil(
          (async () => {
            try {
              if (dispatch) await owned.dispatchPush(4);
            } catch {
              console.error(JSON.stringify({ event: "push_dispatch_failed" }));
            } finally {
              await owned.close();
            }
          })(),
        );
      }
    }
  },
  async scheduled(_controller, env): Promise<void> {
    const runtime = await createWorkerRequestRuntime(
      env,
      env.DATABASE.connectionString,
      env.PUBLIC_API_ORIGIN,
    );
    try {
      const results = await Promise.allSettled([
        runtime.cleanup(),
        runtime.dispatchPush(),
      ]);
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Scheduled maintenance needs retry");
      console.log(JSON.stringify({ event: "media_cleanup_completed" }));
    } catch {
      console.error(JSON.stringify({ event: "media_cleanup_failed" }));
      throw new Error("Media cleanup failed");
    } finally {
      await runtime.close();
    }
  },
} satisfies ExportedHandler<Env>;
