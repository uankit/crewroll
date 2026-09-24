import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../schema/tables.js";
import type { CiphertextStore } from "../../modules/media/ports/mediaService.js";
import type { Clock } from "../../shared/time/clock.js";
import { createKyselyTripLifecycle } from "../trips/kyselyTripLifecycle.js";

type Candidate = { id: string; trip_id: string; kind: "asset" | "upload" };
const leaseMs = 120_000;

export async function cleanupMedia(
  db: Kysely<Database>,
  store: CiphertextStore,
  clock: Clock,
): Promise<number> {
  await createKyselyTripLifecycle(db, clock).expire();
  const available = clock.now();
  const assets = await db
    .selectFrom("assets as a")
    .innerJoin("trips as t", "t.id", "a.trip_id")
    .innerJoin("upload_sessions as u", "u.client_asset_id", "a.id")
    .leftJoin("media_cleanup_claims as c", (join) =>
      join.on("c.id", "=", sql<string>`'asset:' || a.id::text`),
    )
    .select(["a.id", "a.trip_id"])
    .where("u.expires_at", "<=", available)
    .where((eb) =>
      eb.or([eb("c.id", "is", null), eb("c.available_at", "<=", available)]),
    )
    .where((eb) =>
      eb.or([
        eb("a.state", "=", "PURGE_PENDING"),
        eb.and([
          eb("a.state", "=", "COMMITTED"),
          eb("t.hard_delete_at", "<=", available),
        ]),
      ]),
    )
    .orderBy("t.hard_delete_at")
    .orderBy("a.id")
    .limit(100)
    .execute();
  const uploads = await db
    .selectFrom("upload_sessions as u")
    .innerJoin("trips as t", "t.id", "u.trip_id")
    .leftJoin("media_cleanup_claims as c", (join) =>
      join.on("c.id", "=", sql<string>`'upload:' || u.id::text`),
    )
    .select(["u.id", "u.trip_id"])
    .where("u.state", "=", "CREATED")
    .where("u.expires_at", "<=", available)
    .where("t.hard_delete_at", "<=", available)
    .where((eb) =>
      eb.or([eb("c.id", "is", null), eb("c.available_at", "<=", available)]),
    )
    .orderBy("t.hard_delete_at")
    .orderBy("u.id")
    .limit(100)
    .execute();
  const candidates: Candidate[] = [
    ...assets.map((a) => ({ ...a, kind: "asset" as const })),
    ...uploads.map((u) => ({ ...u, kind: "upload" as const })),
  ];

  async function eligible(tx: Transaction<Database>, item: Candidate) {
    const trip = await tx
      .selectFrom("trips")
      .select("hard_delete_at")
      .where("id", "=", item.trip_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const now = clock.now();
    if (item.kind === "upload") {
      const upload = await tx
        .selectFrom("upload_sessions")
        .selectAll()
        .where("id", "=", item.id)
        .executeTakeFirstOrThrow();
      return (
        upload.state === "CREATED" &&
        upload.expires_at <= now &&
        trip.hard_delete_at <= now
      );
    }
    const asset = await tx
      .selectFrom("assets")
      .select("state")
      .where("id", "=", item.id)
      .executeTakeFirstOrThrow();
    const upload = await tx
      .selectFrom("upload_sessions")
      .select("expires_at")
      .where("client_asset_id", "=", item.id)
      .executeTakeFirstOrThrow();
    return (
      upload.expires_at <= now &&
      (asset.state === "PURGE_PENDING" ||
        (asset.state === "COMMITTED" && trip.hard_delete_at <= now))
    );
  }

  async function process(item: Candidate): Promise<number> {
    const id = `${item.kind}:${item.id}`;
    const token = crypto.randomUUID();
    const claim = await db.transaction().execute(async (tx) => {
      if (!(await eligible(tx, item))) return null;
      const claimed = await tx
        .insertInto("media_cleanup_claims")
        .values({
          id,
          token,
          trip_id: item.trip_id,
          available_at: new Date(clock.now().getTime() + leaseMs),
        })
        .onConflict((conflict) =>
          conflict
            .column("id")
            .doUpdateSet({
              token,
              available_at: new Date(clock.now().getTime() + leaseMs),
              attempt_count: sql<number>`media_cleanup_claims.attempt_count + 1`,
            })
            .where("media_cleanup_claims.available_at", "<=", clock.now()),
        )
        .returning("attempt_count")
        .executeTakeFirst();
      if (!claimed) return null;
      const keys =
        item.kind === "asset"
          ? await tx
              .selectFrom("asset_objects")
              .select("s3_key")
              .where("asset_id", "=", item.id)
              .where("deleted_at", "is", null)
              .execute()
          : await tx
              .selectFrom("upload_objects")
              .select("s3_key")
              .where("upload_session_id", "=", item.id)
              .execute();
      return { keys, attempt: claimed.attempt_count };
    });
    if (!claim) return 0;
    try {
      // Retirement is idempotent even if a crashed/slow worker outlives its lease.
      // The R2 adapter fences late PUTs using create-only writes and tombstones.
      for (const { s3_key } of claim.keys) await store.delete(s3_key);
      return await db.transaction().execute(async (tx) => {
        if (!(await eligible(tx, item))) return 0;
        const current = await tx
          .selectFrom("media_cleanup_claims")
          .select("token")
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (current?.token !== token) return 0;
        const now = clock.now();
        if (item.kind === "upload") {
          await tx
            .updateTable("upload_sessions")
            .set({ state: "EXPIRED" })
            .where("id", "=", item.id)
            .execute();
        } else {
          const asset = await tx
            .selectFrom("assets")
            .select("state")
            .where("id", "=", item.id)
            .executeTakeFirstOrThrow();
          await tx
            .updateTable("asset_objects")
            .set({ deleted_at: now })
            .where("asset_id", "=", item.id)
            .where("deleted_at", "is", null)
            .execute();
          if (asset.state === "PURGE_PENDING") {
            await tx
              .updateTable("assets")
              .set({ state: "PURGED", purged_at: now })
              .where("id", "=", item.id)
              .execute();
          } else {
            await tx
              .updateTable("assets")
              .set({ state: "EXPIRED", expired_at: now })
              .where("id", "=", item.id)
              .execute();
            await tx
              .updateTable("deliveries")
              .set({ state: "EXPIRED" })
              .where("asset_id", "=", item.id)
              .where("state", "in", ["READY", "HELD"])
              .execute();
          }
        }
        await tx
          .deleteFrom("media_cleanup_claims")
          .where("id", "=", id)
          .where("token", "=", token)
          .execute();
        return 1;
      });
    } catch {
      await db
        .updateTable("media_cleanup_claims")
        .set({
          available_at: new Date(
            clock.now().getTime() +
              Math.min(300_000, 5_000 * 2 ** Math.min(claim.attempt, 6)),
          ),
        })
        .where("id", "=", id)
        .where("token", "=", token)
        .execute();
      console.warn(
        JSON.stringify({
          event: "media_cleanup_retry",
          attempt: claim.attempt,
        }),
      );
      return 0;
    }
  }

  // Four independent items; a slow trip/object does not serialize the batch.
  let cursor = 0;
  const workers = await Promise.all(
    Array.from({ length: Math.min(4, candidates.length) }, async () => {
      let count = 0;
      while (cursor < candidates.length) {
        const item = candidates[cursor++];
        if (item) count += await process(item);
      }
      return count;
    }),
  );
  return workers.reduce((sum, value) => sum + value, 0);
}
