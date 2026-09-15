import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileCiphertextStore } from "../../src/platform/localMedia/fileCiphertextStore.js";

describe("local ciphertext store", () => {
  let directory: string;
  let now: Date;
  let signingKey: Buffer;
  let media: Awaited<ReturnType<typeof createFileCiphertextStore>>;
  const token = (url: string) => new URL(url).searchParams.get("grant")!;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "crewroll-media-test-"));
    now = new Date("2026-09-08T12:00:00Z");
    signingKey = randomBytes(32);
    media = await createFileCiphertextStore({
      directory,
      origin: "http://127.0.0.1:8787",
      signingKey,
      nodeEnvironment: "test",
      now: () => now,
    });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  async function grant(bytes: Buffer) {
    return media.store.upload(
      {
        key: "trip/session/original",
        bytes: String(bytes.length),
        checksum: createHash("sha256").update(bytes).digest("base64"),
      },
      new Date(now.getTime() + 60_000),
    );
  }
  it("streams immutable bytes, survives reopening, and verifies the digest", async () => {
    const ciphertext = randomBytes(131_073);
    const url = await grant(ciphertext);
    const first = await media.gateway.put(
      token(url),
      Readable.from([
        ciphertext.subarray(0, 50_000),
        ciphertext.subarray(50_000),
      ]),
    );
    expect(
      await media.gateway.put(token(url), Readable.from([ciphertext])),
    ).toEqual(first);
    const restarted = await createFileCiphertextStore({
      directory,
      origin: "http://127.0.0.1:8787",
      signingKey,
      nodeEnvironment: "test",
      now: () => now,
    });
    const download = await restarted.store.download(
      "trip/session/original",
      new Date(now.getTime() + 60_000),
    );
    const result = await restarted.gateway.get(token(download));
    const chunks: Buffer[] = [];
    for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(ciphertext);
    expect(result.etag).toBe(first.etag);
    expect(await readdir(directory)).toHaveLength(1);
  });
  it("rejects tampered, expired, and wrong-operation grants", async () => {
    const ciphertext = randomBytes(100);
    const signed = token(await grant(ciphertext));
    const changed = (signed[0] === "A" ? "B" : "A") + signed.slice(1);
    await expect(
      media.gateway.put(changed, Readable.from([ciphertext])),
    ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
    await expect(media.gateway.get(signed)).rejects.toMatchObject({
      kind: "AUTH_INVALID",
    });
    now = new Date(now.getTime() + 60_000);
    await expect(
      media.gateway.put(signed, Readable.from([ciphertext])),
    ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
    expect(await readdir(directory)).toEqual([]);
  });
  it("rejects truncated, oversized and corrupt bytes, leaving no partial file", async () => {
    const bytes = randomBytes(100);
    const signed = token(await grant(bytes));
    for (const bad of [
      bytes.subarray(0, 99),
      Buffer.concat([bytes, Buffer.from([0])]),
      randomBytes(100),
    ]) {
      await expect(
        media.gateway.put(signed, Readable.from([bad])),
      ).rejects.toBeDefined();
      expect(await readdir(directory)).toEqual([]);
    }
  });
  it("rejects a slow upload that finishes after its grant expires", async () => {
    const bytes = randomBytes(100);
    const signed = token(await grant(bytes));
    async function* slowBody() {
      yield bytes.subarray(0, 50);
      now = new Date(now.getTime() + 60_000);
      await media.store.delete("trip/session/original");
      yield bytes.subarray(50);
    }
    await expect(media.gateway.put(signed, slowBody())).rejects.toMatchObject({
      kind: "AUTH_INVALID",
    });
    expect(await readdir(directory)).toEqual([]);
  });
  it("keeps previously accepted ciphertext immutable under a conflicting grant", async () => {
    const bytes = randomBytes(100);
    await media.gateway.put(token(await grant(bytes)), Readable.from([bytes]));
    const different = randomBytes(100);
    await expect(
      media.gateway.put(
        token(await grant(different)),
        Readable.from([different]),
      ),
    ).rejects.toMatchObject({ kind: "CONFLICT" });
    expect((await media.store.inspect("trip/session/original"))?.checksum).toBe(
      createHash("sha256").update(bytes).digest("base64"),
    );
  });
  it("removes only the addressed ciphertext and handles repeated cleanup", async () => {
    const bytes = randomBytes(100);
    await media.gateway.put(token(await grant(bytes)), Readable.from([bytes]));
    await media.store.delete("trip/session/original");
    await media.store.delete("trip/session/original");
    expect(await media.store.inspect("trip/session/original")).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });
  it("cannot be enabled in production", async () => {
    await expect(
      createFileCiphertextStore({
        directory,
        origin: "https://api.example",
        signingKey,
        nodeEnvironment: "production",
      }),
    ).rejects.toThrow("disabled in production");
  });
  it("purges crashed partial uploads only for the exact expired object", async () => {
    const prefix = (key: string) =>
      createHash("sha256").update(key).digest("hex");
    const partial = `${prefix("trip/session/original")}.01990000-0000-4000-8000-000000000001.upload`;
    const other = `${prefix("another/trip/original")}.01990000-0000-4000-8000-000000000002.upload`;
    await writeFile(path.join(directory, partial), randomBytes(50));
    await writeFile(path.join(directory, other), randomBytes(50));
    await media.store.delete("trip/session/original");
    expect(await readdir(directory)).toEqual([other]);
  });
});
