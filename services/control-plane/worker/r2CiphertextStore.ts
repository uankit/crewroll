import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CiphertextStore } from "../src/modules/media/ports/mediaService.js";
import { DomainError } from "../src/shared/errors/domainError.js";

const MAX_BYTES = 52_428_800;
const grantSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("put"),
      key: z.string().min(1).max(1024),
      expires: z.number().int().positive(),
      bytes: z.string().regex(/^[1-9][0-9]*$/),
      checksum: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    })
    .strict(),
  z
    .object({
      mode: z.literal("get"),
      key: z.string().min(1).max(1024),
      expires: z.number().int().positive(),
    })
    .strict(),
]);
type Grant = z.infer<typeof grantSchema>;

const TOMBSTONE = "crewroll-retired-v1";

export function createR2CiphertextStore(options: {
  bucket: Pick<R2Bucket, "head" | "get" | "put" | "delete">;
  origin: string;
  signingKey: Uint8Array;
  now: () => Date;
}): { store: CiphertextStore; fetch(request: Request): Promise<Response> } {
  const origin = new URL(options.origin);
  if (
    origin.protocol !== "https:" ||
    options.origin !== origin.origin ||
    options.signingKey.length !== 32
  )
    throw new Error("Invalid R2 gateway configuration");
  const signingKey = createHmac("sha256", options.signingKey)
    .update("crewroll/r2-media/v1")
    .digest();
  const sign = (payload: string) =>
    createHmac("sha256", signingKey).update(payload).digest();
  const valid = (grant: Grant) => {
    if (grant.expires <= options.now().getTime())
      throw new DomainError("AUTH_INVALID");
  };
  const url = (input: Grant) => {
    const grant = grantSchema.parse(input);
    valid(grant);
    const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
    return `${origin.origin}/v1/media/object?grant=${payload}.${sign(payload).toString("base64url")}`;
  };
  const verify = (token: string | null): Grant => {
    if (
      !token ||
      token.length > 4096 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    )
      throw new DomainError("AUTH_INVALID");
    const [payload, encoded] = token.split(".");
    if (!payload || !encoded) throw new DomainError("AUTH_INVALID");
    const signature = Buffer.from(encoded, "base64url");
    const expected = sign(payload);
    if (signature.length !== 32 || !timingSafeEqual(signature, expected))
      throw new DomainError("AUTH_INVALID");
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new DomainError("AUTH_INVALID");
    }
    const result = grantSchema.safeParse(parsed);
    if (!result.success) throw new DomainError("AUTH_INVALID");
    valid(result.data);
    return result.data;
  };
  const inspect: CiphertextStore["inspect"] = async (key) => {
    const object = await options.bucket.head(key);
    if (!object || object.customMetadata?.[TOMBSTONE] === "1") return null;
    if (!object.checksums.sha256 || object.size < 1 || object.size > MAX_BYTES)
      throw new DomainError("CONFLICT");
    return {
      bytes: String(object.size),
      checksum: Buffer.from(object.checksums.sha256).toString("base64"),
      etag: object.httpEtag,
    };
  };
  const store: CiphertextStore = {
    upload: (object, expiresAt) =>
      Promise.resolve(
        url({ ...object, mode: "put", expires: expiresAt.getTime() }),
      ),
    download: (key, expiresAt) =>
      Promise.resolve(url({ key, mode: "get", expires: expiresAt.getTime() })),
    inspect,
    async delete(key) {
      // Retire an immutable key atomically. A zero-byte marker replaces all
      // ciphertext and fences any in-flight/replayed create-only PUT. Never
      // delete this marker: doing so would reopen the key to a stale writer.
      // Markers contain no photo bytes, user metadata, or decryption material.
      await options.bucket.put(key, new Uint8Array(), {
        customMetadata: { [TOMBSTONE]: "1" },
        httpMetadata: {
          contentType: "application/octet-stream",
          cacheControl: "no-store",
        },
      });
    },
  };
  return {
    store,
    async fetch(request) {
      const requestUrl = new URL(request.url);
      if (
        requestUrl.origin !== origin.origin ||
        requestUrl.pathname !== "/v1/media/object"
      )
        throw new DomainError("NOT_FOUND");
      const grant = verify(requestUrl.searchParams.get("grant"));
      const headers = {
        "Cache-Control": "no-store",
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      };
      if (request.method === "GET" && grant.mode === "get") {
        const object = await options.bucket.get(grant.key);
        if (!object) throw new DomainError("NOT_FOUND");
        if (object.customMetadata?.[TOMBSTONE] === "1") {
          await object.body.cancel();
          throw new DomainError("NOT_FOUND");
        }
        return new Response(object.body, {
          headers: {
            ...headers,
            ETag: object.httpEtag,
            "Content-Length": String(object.size),
          },
        });
      }
      if (request.method !== "PUT" || grant.mode !== "put")
        throw new DomainError("AUTH_INVALID");
      const bytes = Number(grant.bytes);
      if (
        !Number.isSafeInteger(bytes) ||
        bytes > MAX_BYTES ||
        !request.body ||
        request.headers.get("content-length") !== grant.bytes ||
        request.headers.get("content-type") !== "application/octet-stream" ||
        request.headers.get("x-amz-checksum-sha256") !== grant.checksum ||
        request.headers.get("if-none-match") !== "*"
      )
        throw new DomainError("INVALID_REQUEST");
      {
        valid(grant);
        const prior = await inspect(grant.key);
        if (prior) {
          if (prior.bytes !== grant.bytes || prior.checksum !== grant.checksum)
            throw new DomainError("CONFLICT");
          await request.body?.cancel();
          return new Response(null, {
            headers: { ...headers, ETag: prior.etag },
          });
        }
        // R2 verifies SHA-256 before publishing. FixedLengthStream rejects short
        // and oversized bodies without ever buffering a photo in Worker memory.
        const stream = new FixedLengthStream(bytes);
        const abort = new AbortController();
        const timer = setTimeout(
          () => abort.abort(),
          Math.min(60_000, grant.expires - options.now().getTime()),
        );
        const pumping = request.body!.pipeTo(stream.writable, {
          signal: abort.signal,
        });
        const writing = options.bucket
          .put(grant.key, stream.readable, {
            sha256: Buffer.from(grant.checksum, "base64"),
            onlyIf: { etagDoesNotMatch: "*" },
            httpMetadata: {
              contentType: "application/octet-stream",
              cacheControl: "no-store",
            },
          })
          .then((object) => {
            // A competing PUT or cleanup won. Stop consuming a body R2 no
            // longer needs, then reconcile the immutable winner below.
            if (!object) abort.abort();
            return object;
          })
          .catch((error: unknown) => {
            abort.abort();
            throw error;
          });
        try {
          const results = await Promise.allSettled([pumping, writing]);
          const result = results[1];
          if (result?.status === "fulfilled" && result.value === null) {
            valid(grant);
            const winner = await inspect(grant.key);
            if (
              !winner ||
              winner.bytes !== grant.bytes ||
              winner.checksum !== grant.checksum
            )
              throw new DomainError("CONFLICT");
            return new Response(null, {
              headers: { ...headers, ETag: winner.etag },
            });
          }
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
          if (result?.status !== "fulfilled" || !result.value)
            throw new DomainError("CONFLICT");
          // An expired response cannot authorize commit. Cleanup owns retirement;
          // this old grant must not retire a concurrently renewed session's key.
          valid(grant);
          return new Response(null, {
            headers: { ...headers, ETag: result.value.httpEtag },
          });
        } finally {
          clearTimeout(timer);
        }
      }
    },
  };
}
