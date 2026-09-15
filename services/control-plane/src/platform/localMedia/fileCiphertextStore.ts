import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, link, unlink, stat, readdir } from "node:fs/promises";
import path from "node:path";
import type { CiphertextStore } from "../../modules/media/ports/mediaService.js";
import type { LocalCiphertextGateway } from "../../modules/media/ports/localCiphertextGateway.js";
import { DomainError } from "../../shared/errors/domainError.js";

type Grant = {
  key: string;
  mode: "put" | "get";
  expires: number;
  bytes?: string;
  checksum?: string;
};
const MAX_BYTES = 52_428_800;

export async function createFileCiphertextStore(options: {
  directory: string;
  origin: string;
  signingKey: Uint8Array;
  nodeEnvironment: "development" | "test" | "production";
  now?: () => Date;
}): Promise<{ store: CiphertextStore; gateway: LocalCiphertextGateway }> {
  if (options.nodeEnvironment === "production")
    throw new Error("Local media is disabled in production");
  if (options.signingKey.length !== 32)
    throw new Error("Local media requires a 32-byte signing key");
  const origin = new URL(options.origin);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      ))
  )
    throw new Error("Invalid local media origin");
  const root = path.resolve(options.directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const now = options.now ?? (() => new Date());
  const mutations = new Map<string, Promise<void>>();
  async function mutate<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = mutations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mutations.set(key, pending);
    await prior;
    try {
      return await action();
    } finally {
      release();
      if (mutations.get(key) === pending) mutations.delete(key);
    }
  }
  const signingKey = createHmac("sha256", options.signingKey)
    .update("crewroll/local-media/v1")
    .digest();
  const objectHash = (key: string) =>
    createHash("sha256").update(key).digest("hex");
  const filename = (key: string) =>
    path.join(root, objectHash(key) + ".ciphertext");
  const sign = (payload: string) =>
    createHmac("sha256", signingKey).update(payload).digest();
  const url = (grant: Grant) => {
    const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
    return `${origin.origin}/v1/local-media/object?grant=${payload}.${sign(payload).toString("base64url")}`;
  };
  const verify = (token: string, mode: Grant["mode"]): Grant => {
    if (
      typeof token !== "string" ||
      token.length > 4096 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    )
      throw new DomainError("AUTH_INVALID");
    const [payload, encodedSignature] = token.split(".") as [string, string];
    const signature = Buffer.from(encodedSignature, "base64url");
    const expected = sign(payload);
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(signature, expected)
    )
      throw new DomainError("AUTH_INVALID");
    let grant: Grant;
    try {
      grant = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as Grant;
    } catch {
      throw new DomainError("AUTH_INVALID");
    }
    if (
      !grant ||
      grant.mode !== mode ||
      typeof grant.key !== "string" ||
      !Number.isSafeInteger(grant.expires) ||
      grant.expires <= now().getTime()
    )
      throw new DomainError("AUTH_INVALID");
    return grant;
  };
  const inspect: CiphertextStore["inspect"] = async (key) => {
    const file = filename(key);
    let info;
    try {
      info = await stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!info.isFile() || info.size > MAX_BYTES)
      throw new DomainError("CONFLICT");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file))
      hash.update(chunk as Buffer);
    const checksum = hash.digest("base64");
    return {
      bytes: String(info.size),
      checksum,
      etag: `"${Buffer.from(checksum, "base64").toString("hex")}"`,
    };
  };
  return {
    store: {
      upload(object, expiresAt) {
        return Promise.resolve(
          url({
            key: object.key,
            mode: "put",
            bytes: object.bytes,
            checksum: object.checksum,
            expires: expiresAt.getTime(),
          }),
        );
      },
      inspect,
      download(key, expiresAt) {
        return Promise.resolve(
          url({ key, mode: "get", expires: expiresAt.getTime() }),
        );
      },
      async delete(key) {
        await mutate(key, async () => {
          try {
            await unlink(filename(key));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          // A killed process can leave an unfinished stream. Tie every temporary
          // name to its exact object so the same trip TTL purges those bytes too.
          const partial = new RegExp(
            `^${objectHash(key)}\\.[0-9a-f-]{36}\\.upload$`,
            "u",
          );
          for (const name of await readdir(root)) {
            if (!partial.test(name)) continue;
            await unlink(path.join(root, name)).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              },
            );
          }
        });
      },
    },
    gateway: {
      async put(token, body) {
        const grant = verify(token, "put");
        const expectedBytes = Number(grant.bytes);
        if (
          !Number.isSafeInteger(expectedBytes) ||
          expectedBytes < 1 ||
          expectedBytes > MAX_BYTES
        )
          throw new DomainError("INVALID_REQUEST");
        const temporary = path.join(
          root,
          `${objectHash(grant.key)}.${randomUUID()}.upload`,
        );
        const file = await open(temporary, "wx", 0o600);
        const hash = createHash("sha256");
        let bytes = 0;
        try {
          for await (const chunk of body) {
            bytes += chunk.byteLength;
            if (bytes > expectedBytes) throw new DomainError("INVALID_REQUEST");
            hash.update(chunk);
            await file.writeFile(chunk);
          }
          const checksum = hash.digest("base64");
          if (bytes !== expectedBytes || checksum !== grant.checksum)
            throw new DomainError("CONFLICT");
          await file.sync();
          await file.close();
          await mutate(grant.key, async () => {
            // A request opened before expiry may finish afterwards. Serialize its
            // final publication with deletion and recheck the capability here.
            verify(token, "put");
            try {
              await link(temporary, filename(grant.key));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                throw error;
              // A lost PUT response may be replayed, but never overwrite bytes.
              const existing = await inspect(grant.key);
              if (
                !existing ||
                existing.bytes !== grant.bytes ||
                existing.checksum !== checksum
              )
                throw new DomainError("CONFLICT");
            }
          });
          return {
            etag: `"${Buffer.from(checksum, "base64").toString("hex")}"`,
          };
        } finally {
          await file.close();
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      },
      async get(token) {
        const grant = verify(token, "get");
        const object = await inspect(grant.key);
        if (!object) throw new DomainError("NOT_FOUND");
        return {
          body: createReadStream(filename(grant.key)),
          bytes: Number(object.bytes),
          etag: object.etag,
        };
      },
    },
  };
}
