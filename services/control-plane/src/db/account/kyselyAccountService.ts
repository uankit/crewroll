import { ACCOUNT_TERMS_VERSION } from "@crewroll/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import type {
  AccountService,
  DeleteIdentity,
} from "../../modules/account/ports/accountService.js";
import type { CiphertextStore } from "../../modules/media/ports/mediaService.js";
import { DomainError } from "../../shared/errors/domainError.js";
import type { Clock } from "../../shared/time/clock.js";
import type { Database } from "../schema/tables.js";
import {
  enqueueAccountDeletion,
  eraseAccountRecords,
  stopParticipation,
  subjectHash,
} from "./accountDeletion.js";

type Tx = Transaction<Database>;
export function createKyselyAccountService(
  db: Kysely<Database>,
  store: Pick<CiphertextStore, "delete">,
  clock: Clock,
  deleteIdentity: DeleteIdentity,
  requireTerms = false,
): AccountService {
  async function user(tx: Tx, subject: string) {
    const row = await tx
      .selectFrom("users")
      .selectAll()
      .where("clerk_subject", "=", subject)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.deleted_at || row.suspended_at)
      throw new DomainError("AUTH_INVALID");
    return row;
  }
  async function rate(subject: string, operation: string, maximum: number) {
    const start = new Date(Math.floor(clock.now().getTime() / 60_000) * 60_000);
    const key = `${await subjectHash(subject)}:${operation}`;
    const result = await sql<{
      count: number;
    }>`insert into request_limits (key, window_start, count)
      values (${key}, ${start}, 1) on conflict (key, window_start) do update
      set count = request_limits.count + 1 returning count`.execute(db);
    if ((result.rows[0]?.count ?? maximum + 1) > maximum)
      throw new DomainError("RATE_LIMITED");
  }
  async function memberTarget(
    tx: Tx,
    userId: string,
    tripId: string,
    membershipId: string,
  ) {
    const own = await tx
      .selectFrom("trip_members")
      .selectAll()
      .where("user_id", "=", userId)
      .where("trip_id", "=", tripId)
      .where("state", "!=", "REJECTED")
      .executeTakeFirst();
    const target = await tx
      .selectFrom("trip_members")
      .selectAll()
      .where("id", "=", membershipId)
      .where("trip_id", "=", tripId)
      .where("state", "!=", "REJECTED")
      .executeTakeFirst();
    if (!own || !target || target.user_id === userId)
      throw new DomainError("NOT_FOUND");
    return target;
  }
  return {
    async policy(subject) {
      return db.transaction().execute(async (tx) => {
        const account = await user(tx, subject);
        const acceptance = await tx
          .selectFrom("account_terms")
          .select("terms_version")
          .where("user_id", "=", account.id)
          .executeTakeFirst();
        return {
          termsVersion: ACCOUNT_TERMS_VERSION,
          accepted: acceptance?.terms_version === ACCOUNT_TERMS_VERSION,
        };
      });
    },
    async acceptTerms(subject) {
      return db.transaction().execute(async (tx) => {
        const account = await user(tx, subject);
        await tx
          .insertInto("account_terms")
          .values({
            user_id: account.id,
            terms_version: ACCOUNT_TERMS_VERSION,
            accepted_at: clock.now(),
          })
          .onConflict((c) =>
            c.column("user_id").doUpdateSet({
              terms_version: ACCOUNT_TERMS_VERSION,
              accepted_at: clock.now(),
            }),
          )
          .execute();
        return { termsVersion: ACCOUNT_TERMS_VERSION, accepted: true };
      });
    },
    async requestDeletion(subject) {
      return db.transaction().execute(async (tx) => {
        let account = await tx
          .selectFrom("users")
          .selectAll()
          .where("clerk_subject", "=", subject)
          .forUpdate()
          .executeTakeFirst();
        const existing = await tx
          .selectFrom("account_deletions")
          .selectAll()
          .where("clerk_subject", "=", subject)
          .executeTakeFirst();
        if (existing)
          return {
            requestId: existing.id,
            status: existing.completed_at
              ? ("COMPLETE" as const)
              : ("PENDING" as const),
          };
        if (!account) {
          // A person may delete a Clerk account before ever opening the app.
          // The insert also serializes with a racing first profile sync.
          const result = await sql<Database["users"]>`insert into users
            (id, clerk_subject, display_name, created_at, updated_at, deleted_at)
            select ${crypto.randomUUID()}::uuid, ${subject}, 'Deleted account', ${clock.now()}, ${clock.now()}, ${clock.now()}
            where not exists (select 1 from account_deleted_subjects where subject_hash = ${await subjectHash(subject)})
            on conflict (clerk_subject) do update set deleted_at = coalesce(users.deleted_at, excluded.deleted_at)
            returning *`.execute(tx);
          account = result.rows[0] as typeof account;
          if (!account) throw new DomainError("AUTH_INVALID");
        }
        return {
          requestId: await enqueueAccountDeletion(
            tx,
            account.id,
            subject,
            clock.now(),
          ),
          status: "PENDING" as const,
        };
      });
    },
    async deletionStatus(requestId) {
      const row = await db
        .selectFrom("account_deletions")
        .select(["id", "completed_at"])
        .where("id", "=", requestId)
        .executeTakeFirst();
      if (!row) throw new DomainError("NOT_FOUND");
      return {
        requestId: row.id,
        status: row.completed_at ? "COMPLETE" : "PENDING",
      };
    },
    async report(subject, body) {
      if (Boolean(body.membershipId) === Boolean(body.assetId))
        throw new DomainError("INVALID_REQUEST");
      await rate(subject, "report", 5);
      return db.transaction().execute(async (tx) => {
        const account = await user(tx, subject);
        let targetUserId: string;
        if (body.membershipId)
          targetUserId = (
            await memberTarget(tx, account.id, body.tripId, body.membershipId)
          ).user_id;
        else {
          const own = await tx
            .selectFrom("trip_members")
            .select("id")
            .where("trip_id", "=", body.tripId)
            .where("user_id", "=", account.id)
            .where("state", "=", "ACTIVE")
            .executeTakeFirst();
          const asset = await tx
            .selectFrom("assets as a")
            .innerJoin("devices as d", "d.id", "a.source_device_id")
            .select("d.user_id")
            .where("a.id", "=", body.assetId!)
            .where("a.trip_id", "=", body.tripId)
            .executeTakeFirst();
          if (!own || !asset || asset.user_id === account.id)
            throw new DomainError("NOT_FOUND");
          targetUserId = asset.user_id;
        }
        const reportId = crypto.randomUUID();
        await tx
          .insertInto("safety_reports")
          .values({
            id: reportId,
            reporter_user_id: account.id,
            subject_user_id: targetUserId,
            trip_id: body.tripId,
            asset_id: body.assetId ?? null,
            reason: body.reason,
            details: body.details?.trim() ?? "",
            created_at: clock.now(),
            resolved_at: null,
            resolution: null,
          })
          .execute();
        return { reportId };
      });
    },
    async block(subject, body) {
      await rate(subject, "block", 10);
      await db.transaction().execute(async (tx) => {
        const account = await user(tx, subject);
        // Serialize with join/approval before examining membership or leaving.
        await tx
          .selectFrom("trips")
          .select("id")
          .where("id", "=", body.tripId)
          .forUpdate()
          .execute();
        const target = await memberTarget(
          tx,
          account.id,
          body.tripId,
          body.membershipId,
        );
        const total = await tx
          .selectFrom("user_blocks")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("user_id", "=", account.id)
          .executeTakeFirstOrThrow();
        if (Number(total.count) >= 100) throw new DomainError("RATE_LIMITED");
        await tx
          .insertInto("user_blocks")
          .values({
            user_id: account.id,
            blocked_user_id: target.user_id,
            created_at: clock.now(),
          })
          .onConflict((c) =>
            c.columns(["user_id", "blocked_user_id"]).doNothing(),
          )
          .execute();
        await stopParticipation(tx, account.id, clock.now(), body.tripId);
      });
    },
    async blockedMembers(subject) {
      return db.transaction().execute(async (tx) => {
        const account = await user(tx, subject);
        const rows = await tx
          .selectFrom("user_blocks as b")
          .innerJoin("users as u", "u.id", "b.blocked_user_id")
          .select(["u.id", "u.display_name"])
          .where("b.user_id", "=", account.id)
          .orderBy("b.created_at", "desc")
          .limit(100)
          .execute();
        return {
          items: rows.map((row) => ({
            userId: row.id,
            displayName: row.display_name,
          })),
        };
      });
    },
    async unblock(subject, userId) {
      await db.transaction().execute(async (tx) => {
        const account = await user(tx, subject);
        await tx
          .deleteFrom("user_blocks")
          .where("user_id", "=", account.id)
          .where("blocked_user_id", "=", userId)
          .execute();
      });
    },
    async guard(subject, operation) {
      await rate(
        subject,
        operation,
        { read: 300, write: 60, join: 10, create: 5, register: 10 }[operation],
      );
      const denied = await sql<{ denied: boolean }>`select
        exists(select 1 from account_deleted_subjects where subject_hash = ${await subjectHash(subject)})
        or exists(select 1 from users where clerk_subject = ${subject} and suspended_at is not null)
        as denied`.execute(db);
      if (denied.rows[0]?.denied) throw new DomainError("AUTH_INVALID");
      if (requireTerms && ["join", "create", "register"].includes(operation)) {
        const terms = await db
          .selectFrom("account_terms as t")
          .innerJoin("users as u", "u.id", "t.user_id")
          .select("t.terms_version")
          .where("u.clerk_subject", "=", subject)
          .where("u.deleted_at", "is", null)
          .executeTakeFirst();
        if (terms?.terms_version !== ACCOUNT_TERMS_VERSION)
          throw new DomainError("CONFLICT");
      }
    },
    async cleanup() {
      const now = clock.now();
      const jobs = await db.transaction().execute(async (tx) => {
        const rows = await tx
          .selectFrom("account_deletions")
          .selectAll()
          .where("completed_at", "is", null)
          .where("available_at", "<=", now)
          .orderBy("available_at")
          .limit(4)
          .forUpdate()
          .skipLocked()
          .execute();
        const claimed = [];
        for (const row of rows) {
          const token = crypto.randomUUID();
          await tx
            .updateTable("account_deletions")
            .set({
              lease_token: token,
              available_at: new Date(now.getTime() + 300_000),
              attempt_count: row.attempt_count + 1,
            })
            .where("id", "=", row.id)
            .execute();
          claimed.push({ ...row, token });
        }
        return claimed;
      });
      let failed = false;
      for (const job of jobs) {
        try {
          if (
            (!job.provider_deleted_at || job.apple_grant) &&
            job.clerk_subject
          ) {
            await deleteIdentity(job.clerk_subject, {
              appleGrant: job.apple_grant,
              appleRevoked: job.apple_revoked,
              async checkpoint(grant, revoked) {
                const updated = await db
                  .updateTable("account_deletions")
                  .set({ apple_grant: grant, apple_revoked: revoked })
                  .where("id", "=", job.id)
                  .where("lease_token", "=", job.token)
                  .executeTakeFirst();
                if (updated.numUpdatedRows !== 1n)
                  throw new Error("Account deletion lease expired");
              },
            });
            await db
              .updateTable("account_deletions")
              .set({ provider_deleted_at: clock.now() })
              .where("id", "=", job.id)
              .where("lease_token", "=", job.token)
              .execute();
          }
          const objects = await db
            .selectFrom("account_deletion_objects")
            .select("object_key")
            .where("request_id", "=", job.id)
            .where("deleted_at", "is", null)
            .limit(100)
            .execute();
          for (let index = 0; index < objects.length; index += 4) {
            const results = await Promise.allSettled(
              objects.slice(index, index + 4).map(async (object) => {
                await store.delete(object.object_key);
                await db
                  .updateTable("account_deletion_objects")
                  .set({ deleted_at: clock.now() })
                  .where("request_id", "=", job.id)
                  .where("object_key", "=", object.object_key)
                  .execute();
              }),
            );
            if (results.some((result) => result.status === "rejected"))
              throw new Error("Account storage cleanup needs retry");
          }
          await db.transaction().execute(async (tx) => {
            // Match user-before-trip lock order even on repeated cleanup runs.
            if (job.user_id)
              await tx
                .selectFrom("users")
                .select("id")
                .where("id", "=", job.user_id)
                .forUpdate()
                .execute();
            const current = await tx
              .selectFrom("account_deletions")
              .selectAll()
              .where("id", "=", job.id)
              .where("lease_token", "=", job.token)
              .forUpdate()
              .executeTakeFirst();
            if (!current || current.completed_at) return;
            const remaining = await tx
              .selectFrom("account_deletion_objects")
              .select("object_key")
              .where("request_id", "=", job.id)
              .where("deleted_at", "is", null)
              .executeTakeFirst();
            if (remaining || !current.provider_deleted_at) {
              await tx
                .updateTable("account_deletions")
                .set({ available_at: clock.now(), lease_token: null })
                .where("id", "=", job.id)
                .execute();
              return;
            }
            if (job.user_id) await eraseAccountRecords(tx, job.user_id);
            await tx
              .deleteFrom("account_deletion_objects")
              .where("request_id", "=", job.id)
              .execute();
            await tx
              .updateTable("account_deletions")
              .set({
                completed_at: clock.now(),
                apple_grant: null,
                user_id: null,
                clerk_subject: null,
                lease_token: null,
              })
              .where("id", "=", job.id)
              .execute();
          });
        } catch {
          failed = true;
          await db
            .updateTable("account_deletions")
            .set({
              available_at: new Date(
                clock.now().getTime() +
                  Math.min(3600, 30 * 2 ** Math.min(job.attempt_count, 7)) *
                    1000,
              ),
              lease_token: null,
            })
            .where("id", "=", job.id)
            .where("lease_token", "=", job.token)
            .execute();
        }
      }
      await db
        .deleteFrom("request_limits")
        .where("window_start", "<", new Date(now.getTime() - 86_400_000))
        .execute();
      await db
        .deleteFrom("account_deletions")
        .where("completed_at", "<", new Date(now.getTime() - 30 * 86_400_000))
        .execute();
      await db
        .deleteFrom("account_deleted_subjects")
        .where("deleted_at", "<", new Date(now.getTime() - 90 * 86_400_000))
        .execute();
      await db
        .deleteFrom("safety_reports")
        .where("resolved_at", "<", new Date(now.getTime() - 90 * 86_400_000))
        .execute();
      if (failed) throw new Error("Account cleanup needs retry");
    },
  };
}
