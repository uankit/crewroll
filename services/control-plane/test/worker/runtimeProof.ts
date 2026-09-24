// Local workerd proof fixture. Never deploy this test entrypoint.
import { createHash } from "node:crypto";
import { createR2CiphertextStore } from "../../worker/r2CiphertextStore.js";
import { workerApp } from "../../worker/scopedApp.js";
import { createWorkerRequestRuntime } from "../../worker/requestRuntime.js";
import { createClerkIdentityDeletion } from "../../src/platform/clerk/deleteClerkIdentity.js";
import contract from "@crewroll/contracts/generated/crewroll.openapi.json" with { type: "json" };

export default {
  async fetch(
    _request: Request,
    env: Pick<Env, "CIPHERTEXT">,
    ctx: ExecutionContext,
  ) {
    const passed: string[] = [];
    const assert = (condition: unknown, name: string) => {
      if (!condition) throw new Error(name);
      passed.push(name);
    };
    let now = Date.now();
    const adapter = createR2CiphertextStore({
      bucket: env.CIPHERTEXT,
      origin: "https://crewroll.invalid",
      signingKey: new Uint8Array(32).fill(9),
      now: () => new Date(now),
    });
    const key = `proof/${crypto.randomUUID()}`;
    const body = new Uint8Array([3, 8, 2, 9]);
    const object = {
      key,
      bytes: String(body.length),
      checksum: createHash("sha256").update(body).digest("base64"),
    };
    const expires = new Date(now + 30_000);
    const url = await adapter.store.upload(object, expires);
    const put = (bytes = body, target = url) =>
      adapter.fetch(
        new Request(target, {
          method: "PUT",
          body: bytes,
          headers: {
            "content-length": String(bytes.length),
            "content-type": "application/octet-stream",
            "x-amz-checksum-sha256": object.checksum,
            "if-none-match": "*",
          },
        }),
      );
    try {
      const originalFetch = globalThis.fetch;
      try {
        // Construct real workerd Requests: Node accepts redirect modes the edge rejects.
        globalThis.fetch = (input, init) => {
          const request = new Request(input, init);
          assert(
            request.redirect === "manual",
            "Provider requests cannot redirect credentials",
          );
          return Promise.resolve(Response.json({ external_accounts: [] }));
        };
        let checkpoints = 0;
        await createClerkIdentityDeletion(
          "local-proof-only",
          {
            clientId: "local",
            teamId: "local",
            keyId: "local",
            privateKey: "unused",
          },
          new Uint8Array(32).fill(7),
        )("user_local_proof", {
          appleGrant: null,
          appleRevoked: false,
          checkpoint: () => {
            checkpoints += 1;
            return Promise.resolve();
          },
        });
        assert(
          checkpoints === 2,
          "Encrypted deletion checkpoint works in workerd",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
      const secret = Buffer.alloc(32, 7).toString("base64");
      const runtime = await createWorkerRequestRuntime(
        {
          ...env,
          CLERK_ISSUER: "https://creative-oriole-5086.clerk.accounts.dev",
          CLERK_AUTHORIZED_PARTIES_JSON: "[]",
          REQUIRE_TERMS: "false",
          CLERK_SECRET_KEY: "sk_test_local_runtime_proof_only",
          CLERK_WEBHOOK_SECRET: `whsec_${secret}`,
          BACKGROUND_CREDENTIAL_HMAC_KEY_V1: secret,
          INVITE_CODE_HMAC_KEY: "local-runtime-proof-only",
          MEDIA_SIGNING_KEY_V1: secret,
          PUSH_TOKEN_ENCRYPTION_KEY_V1: secret,
        },
        "postgresql://proof:proof@127.0.0.1:1/proof",
        "https://crewroll.invalid",
      );
      try {
        const live = await runtime.fetch(
          new Request("https://crewroll.invalid/health/live"),
          ctx,
        );
        assert(live.status === 200, "Composed Worker API responds");
        await live.text();
        const denied = await runtime.fetch(
          new Request("https://crewroll.invalid/v1/trips", { method: "POST" }),
          ctx,
        );
        assert(
          denied.status === 401,
          "Real trip routes reject missing Clerk auth",
        );
        await denied.text();
        for (const method of ["GET", "POST"]) {
          const deniedContinuity = await runtime.fetch(
            new Request(
              "https://crewroll.invalid/v1/trips/01990000-0000-7000-8000-000000000001/continuity",
              { method },
            ),
            ctx,
          );
          assert(
            deniedContinuity.status === 401,
            `${method} continuity is wired through Worker auth`,
          );
          await deniedContinuity.text();
        }
      } finally {
        await runtime.close();
      }
      assert(
        workerApp.hasRoute({ method: "POST", url: "/v1/trips" }),
        "Fastify compiles trip routes in workerd",
      );
      for (const [path, operation] of Object.entries(contract.paths)) {
        for (const [schemaMethod, method] of [
          ["get", "GET"],
          ["post", "POST"],
          ["put", "PUT"],
          ["patch", "PATCH"],
          ["delete", "DELETE"],
        ] as const) {
          if (schemaMethod in operation)
            assert(
              workerApp.hasRoute({
                method,
                url: path.replace(/\{([^}]+)\}/g, ":$1"),
              }),
              `Worker implements ${method} ${path}`,
            );
        }
      }
      assert(
        workerApp.hasRoute({
          method: "POST",
          url: "/v1/assets/upload-sessions",
        }),
        "Fastify compiles media routes in workerd",
      );
      const uploaded = await put();
      assert(uploaded.status === 200, "R2 streaming upload");
      const inspected = await adapter.store.inspect(key);
      assert(
        inspected?.checksum === object.checksum,
        "R2 validates and persists SHA256",
      );
      assert(
        (await put()).headers.get("etag") === uploaded.headers.get("etag"),
        "Lost PUT response is idempotent",
      );
      const download = await adapter.fetch(
        new Request(await adapter.store.download(key, expires)),
      );
      assert(
        Buffer.from(await download.arrayBuffer()).equals(body),
        "Ciphertext round trip",
      );
      assert(
        download.headers.get("cache-control") === "no-store",
        "No cached capability response",
      );
      const raceKey = `${key}/race`;
      const raceUrl = await adapter.store.upload(
        { ...object, key: raceKey },
        expires,
      );
      const winners = await Promise.all([
        put(body, raceUrl),
        put(body, raceUrl),
      ]);
      assert(
        winners.every((response) => response.status === 200) &&
          winners[0]?.headers.get("etag") === winners[1]?.headers.get("etag"),
        "Concurrent immutable PUTs reconcile one stored object",
      );
      await adapter.store.delete(raceKey);
      let retiredRejected = false;
      try {
        await put(body, raceUrl);
      } catch {
        retiredRejected = true;
      }
      assert(
        retiredRejected && (await adapter.store.inspect(raceKey)) === null,
        "A still-valid grant cannot resurrect retired ciphertext",
      );

      const slowKey = `${key}/slow`;
      const slowUrl = await adapter.store.upload(
        { ...object, key: slowKey },
        expires,
      );
      let finish!: () => void;
      const delayed = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.slice(0, 2));
          finish = () => {
            controller.enqueue(body.slice(2));
            controller.close();
          };
        },
      });
      const latePut = adapter
        .fetch(
          new Request(slowUrl, {
            method: "PUT",
            body: delayed,
            headers: {
              "content-length": object.bytes,
              "content-type": "application/octet-stream",
              "x-amz-checksum-sha256": object.checksum,
              "if-none-match": "*",
            },
          }),
        )
        .then(
          () => false,
          () => true,
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
      await adapter.store.delete(slowKey);
      finish();
      assert(
        (await latePut) && (await adapter.store.inspect(slowKey)) === null,
        "Cleanup fences an already-streaming late PUT without a DB lock",
      );
      const marker = await env.CIPHERTEXT.head(slowKey);
      assert(marker?.size === 0, "Retirement retains no ciphertext bytes");
      const badKey = `${key}/bad`;
      try {
        const badUrl = await adapter.store.upload(
          { ...object, key: badKey },
          expires,
        );
        await put(new Uint8Array([1, 1, 1, 1]), badUrl);
        throw new Error("Checksum mismatch accepted");
      } catch {
        assert(
          (await env.CIPHERTEXT.head(badKey)) === null,
          "Corrupt ciphertext never published",
        );
      }
      now = expires.getTime();
      let expired = false;
      try {
        await put();
      } catch {
        expired = true;
      }
      assert(expired, "Expired upload rejected");
      await adapter.store.delete(key);
      assert((await adapter.store.inspect(key)) === null, "Ciphertext cleanup");
      return Response.json({ passed });
    } finally {
      await env.CIPHERTEXT.delete([
        key,
        `${key}/bad`,
        `${key}/race`,
        `${key}/slow`,
      ]);
    }
  },
};
