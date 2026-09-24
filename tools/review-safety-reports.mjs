// Operator-only CLI. Requires explicit --apply for any account/content action.
import process from "node:process";
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { stopParticipation } from "../services/control-plane/dist/src/db/account/accountDeletion.js";

const args = process.argv.slice(2);
const action = args[0] ?? "list";
const reportId = args[1];
if (
  !["list", "dismiss", "remove-photo", "ban-member"].includes(action) ||
  (action !== "list" &&
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(reportId ?? ""))
)
  throw new Error(
    "Usage: review-safety-reports.mjs list | dismiss|remove-photo|ban-member REPORT_UUID [--apply]",
  );
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const database = new Kysely({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 }),
  }),
});
try {
  if (action === "list") {
    const rows = await database
      .selectFrom("safety_reports")
      .select([
        "id",
        "reason",
        "created_at",
        "asset_id",
        "trip_id",
        "subject_user_id",
        "details",
      ])
      .where("resolved_at", "is", null)
      .orderBy("created_at")
      .limit(100)
      .execute();
    console.log(JSON.stringify(rows, null, 2));
  } else {
    const report = await database
      .selectFrom("safety_reports")
      .selectAll()
      .where("id", "=", reportId)
      .executeTakeFirstOrThrow();
    if (report.resolved_at) throw new Error("This report is already resolved");
    const target = report.subject_user_id
      ? await database
          .selectFrom("users")
          .select(["id", "clerk_subject"])
          .where("id", "=", report.subject_user_id)
          .executeTakeFirst()
      : null;
    console.log(
      JSON.stringify({
        action,
        reportId,
        targetUserId: target?.id ?? null,
        assetId: report.asset_id,
        apply: args.includes("--apply"),
      }),
    );
    if (action === "remove-photo" && !report.asset_id)
      throw new Error("This report has no photo");
    if (action === "ban-member" && !target)
      throw new Error("The reported account is no longer present");
    if (args.includes("--apply")) {
      if (action === "ban-member") {
        if (!process.env.CLERK_SECRET_KEY)
          throw new Error("CLERK_SECRET_KEY is required");
        const response = await fetch(
          `https://api.clerk.com/v1/users/${encodeURIComponent(target.clerk_subject)}/ban`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
            },
            signal: AbortSignal.timeout(10000),
            redirect: "error",
          },
        );
        const success = response.ok;
        await response.body?.cancel();
        if (!success)
          throw new Error("Clerk suspension failed; report remains open");
      }
      await database.transaction().execute(async (tx) => {
        const now = new Date();
        if (action === "ban-member") {
          await tx
            .updateTable("users")
            .set({ suspended_at: now, updated_at: now })
            .where("id", "=", target.id)
            .execute();
          await tx
            .updateTable("devices")
            .set({
              revoked_at: now,
              encrypted_push_token: null,
              push_token_hash: null,
              updated_at: now,
            })
            .where("user_id", "=", target.id)
            .execute();
          await stopParticipation(tx, target.id, now);
        }
        if (action === "remove-photo") {
          await tx
            .selectFrom("trips")
            .select("id")
            .where("id", "=", report.trip_id)
            .forUpdate()
            .execute();
          await tx
            .updateTable("assets")
            .set({ state: "PURGE_PENDING" })
            .where("id", "=", report.asset_id)
            .execute();
          await tx
            .updateTable("deliveries")
            .set({ state: "EXPIRED" })
            .where("asset_id", "=", report.asset_id)
            .where("state", "in", ["HELD", "READY"])
            .execute();
        }
        await tx
          .updateTable("safety_reports")
          .set({
            resolved_at: now,
            resolution:
              action === "dismiss"
                ? "DISMISSED"
                : action === "remove-photo"
                  ? "REMOVED"
                  : "ACTION_TAKEN",
          })
          .where("id", "=", reportId)
          .where("resolved_at", "is", null)
          .execute();
      });
      console.log("Report resolved.");
    }
  }
} finally {
  await database.destroy();
}
