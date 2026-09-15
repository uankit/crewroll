/** Explicit opt-in hosted transport probe. Synthetic isolated users only; no real photos. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../services/control-plane/src/db/database.js";
import { createIdentityTripFixtures } from "../tests/integration/support/fixtures.js";

assert.equal(
  process.env.CREWROLL_HOSTED_PROOF,
  "SYNTHETIC_FIVE_MEMBER_PREVIEW_ONLY",
);
const databaseUrl = process.env.DATABASE_URL!;
assert.equal(
  new URL(databaseUrl).hostname,
  "db.ipvafmewwcgxdnevoqyg.supabase.co",
);
const origin = "https://crewroll-api.uankitu.workers.dev";
const db = createDatabase(databaseUrl, {
  maxConnections: 2,
  connectionTimeoutMillis: 10000,
});
const fixtures = createIdentityTripFixtures(db);
const run = randomUUID();
const tripId = randomUUID().slice(0, 14) + "7" + randomUUID().slice(15);
const members: { userId: string; deviceId: string; token: string }[] = [];
const users: string[] = [];
let tripCreated = false;
let stage = "seed";
const shell = promisify(execFile);
const now = new Date();
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("base64");
const headers = (index: number) => ({
  authorization: `Bearer ${members[index]!.token}`,
  "x-crewroll-device-id": members[index]!.deviceId,
  "idempotency-key": randomUUID(),
  "content-type": "application/json",
});
async function json(path: string, index: number, body?: unknown) {
  const response = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: headers(index),
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.ok, true, `${stage}: HTTP ${response.status}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}

try {
  console.log(
    JSON.stringify({ event: "synthetic_preview_probe_started", run, tripId }),
  );
  for (let i = 0; i < 5; i++) {
    const id = randomUUID();
    await fixtures.user({
      id,
      clerk_subject: `user_crewroll_probe_${run}_${i}`,
      display_name: "Synthetic speed probe",
      created_at: now,
      updated_at: now,
    });
    users.push(id);
    const token = `crb_${randomBytes(32).toString("base64url")}`;
    const deviceId = randomUUID();
    await fixtures.device(id, {
      id: deviceId,
      installation_id: `speed_probe_${run}_${i}`,
      background_credential_hash: createHash("sha256").update(token).digest(),
      background_credential_expires_at: new Date(now.getTime() + 3600000),
      created_at: now,
      updated_at: now,
    });
    members.push({ userId: id, deviceId, token });
  }
  const ends = new Date(now.getTime() + 3600000);
  await fixtures.trip(users[0]!, {
    id: tripId,
    name: "Synthetic transport probe",
    state: "ACTIVE",
    member_count: 5,
    created_at: now,
    started_at: now,
    updated_at: now,
    ends_at: ends,
    hard_delete_at: new Date(ends.getTime() + 7 * 86400000),
  });
  tripCreated = true;
  for (const member of members)
    await fixtures.member(tripId, member.userId, member.deviceId, {
      id: randomUUID(),
      role: member === members[0] ? "OWNER" : "MEMBER",
      full_photo_library_access: true,
      created_at: now,
      updated_at: now,
      approved_at: now,
    });
  const cursors = new Array<string>(5).fill("0");
  for (let trial = 1; trial <= 3; trial++) {
    const assetId = randomUUID();
    const preview = randomBytes(96 * 1024);
    const started = performance.now();
    stage = "create-upload";
    const session = await json("/v1/assets/upload-sessions", 0, {
      tripId,
      assetId,
      sourceAssetKey: `src_${randomBytes(32).toString("base64url")}`,
      capturedAt: new Date().toISOString(),
      formatVersion: 1,
      keyEpoch: 1,
      encryptedManifest: randomBytes(256).toString("base64"),
      objects: [
        {
          variant: "PREVIEW",
          ciphertextBytes: String(preview.length),
          checksumSha256: hash(preview),
        },
        {
          variant: "ORIGINAL",
          ciphertextBytes: String(12 * 1024 * 1024),
          checksumSha256: hash(randomBytes(32)),
        },
      ],
    });
    const created = performance.now();
    stage = "upload-preview";
    const upload = session.objects[0];
    assert.equal(new URL(upload.url).origin, origin);
    const response = await fetch(upload.url, {
      method: "PUT",
      headers: upload.requiredHeaders,
      body: preview,
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.ok, true, `preview PUT ${response.status}`);
    await response.arrayBuffer();
    const uploaded = performance.now();
    stage = "publish-preview";
    await json(`/v1/assets/${assetId}/preview`, 0, {
      uploadSessionId: session.uploadSessionId,
      etag: response.headers.get("etag"),
    });
    const published = performance.now();
    stage = "receive-five-member-feed";
    const received = await Promise.all(
      members.map(async (_member, index) => {
        const feed = await json(
          `/v1/trips/${tripId}/previews?after=${cursors[index]}`,
          index,
        );
        const item = feed.items.find(
          (item: { assetId: string }) => item.assetId === assetId,
        );
        assert.ok(item);
        cursors[index] = feed.nextCursor;
        const url = item.download.object.url;
        assert.equal(new URL(url).origin, origin);
        const download = await fetch(url, {
          signal: AbortSignal.timeout(30000),
        });
        assert.equal(download.ok, true);
        const bytes = new Uint8Array(await download.arrayBuffer());
        assert.equal(hash(bytes), hash(preview));
        return Math.round(performance.now() - published);
      }),
    );
    assert.equal(
      (
        await db
          .selectFrom("assets")
          .select("id")
          .where("trip_id", "=", tripId)
          .execute()
      ).length,
      0,
    );
    console.log(
      JSON.stringify({
        event: "synthetic_preview_trial",
        trial,
        members: 5,
        previewBytes: preview.length,
        originalBytesUploaded: 0,
        createMs: Math.round(created - started),
        previewPutMs: Math.round(uploaded - created),
        publishMs: Math.round(published - uploaded),
        receiveMs: received,
        networkToAllPreviewsMs:
          Math.round(published - started) + Math.max(...received),
      }),
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({
      event: "synthetic_preview_probe_failed",
      stage,
      assertion:
        error instanceof assert.AssertionError
          ? error.message
          : "operation failed",
    }),
  );
  process.exitCode = 1;
} finally {
  // Delete only this run's generated object keys, then its FK-scoped records.
  // Never truncate tables or touch existing users/trips.
  try {
    if (tripCreated) {
      const sessions = await db
        .selectFrom("upload_sessions")
        .select("id")
        .where("trip_id", "=", tripId)
        .execute();
      const ids = sessions.map((session) => session.id);
      if (ids.length) {
        const objects = await db
          .selectFrom("upload_objects")
          .select("s3_key")
          .where("upload_session_id", "in", ids)
          .execute();
        for (const object of objects) {
          assert.ok(object.s3_key.startsWith(`media/${tripId}/`));
          await shell(
            process.execPath,
            [
              fileURLToPath(
                new URL(
                  "../node_modules/wrangler/bin/wrangler.js",
                  import.meta.url,
                ),
              ),
              "r2",
              "object",
              "delete",
              `crewroll-ciphertext/${object.s3_key}`,
              "--remote",
            ],
            {
              cwd: fileURLToPath(
                new URL("../services/control-plane", import.meta.url),
              ),
            },
          );
        }
        await db
          .deleteFrom("upload_objects")
          .where("upload_session_id", "in", ids)
          .execute();
        await db.deleteFrom("upload_sessions").where("id", "in", ids).execute();
      }
      await db
        .deleteFrom("inbox_events")
        .where("trip_id", "=", tripId)
        .execute();
      await db
        .deleteFrom("trip_members")
        .where("trip_id", "=", tripId)
        .execute();
      await db.deleteFrom("trips").where("id", "=", tripId).execute();
    }
    for (const member of members)
      await db
        .deleteFrom("devices")
        .where("id", "=", member.deviceId)
        .where("user_id", "=", member.userId)
        .execute();
    if (users.length)
      await db.deleteFrom("users").where("id", "in", users).execute();
    console.log(
      JSON.stringify({ event: "synthetic_preview_probe_cleaned", run }),
    );
  } catch {
    console.error(
      JSON.stringify({
        event: "synthetic_preview_probe_cleanup_required",
        run,
        tripId,
      }),
    );
    process.exitCode = 1;
  }
  await db.destroy();
}
