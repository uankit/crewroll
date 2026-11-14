import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("trip_members")
    .dropConstraint("trip_members_lifecycle_check")
    .execute();
  await db.schema
    .alterTable("trip_members")
    .addCheckConstraint(
      "trip_members_lifecycle_check",
      sql`
        (
          state = 'PENDING_KEY'
          and role = 'MEMBER'
          and key_epoch is null
          and approved_at is null
          and rejected_at is null
        ) or (
          state = 'ACTIVE'
          and key_epoch is not null
          and key_epoch = 1
          and approved_at is not null
          and rejected_at is null
        ) or (
          state = 'REJECTED'
          and role = 'MEMBER'
          and key_epoch is null
          and approved_at is null
          and rejected_at is not null
        )
      `,
    )
    .execute();
  await db.schema
    .alterTable("push_wakeups")
    .dropConstraint("push_wakeups_completion_check")
    .execute();
  await db.schema
    .alterTable("push_wakeups")
    .addCheckConstraint(
      "push_wakeups_completion_check",
      sql`(completed_at is null and outcome is null) or (completed_at is not null and outcome is not null and outcome in ('SENT', 'INELIGIBLE', 'EXPIRED', 'INVALID_TOKEN', 'DEAD_LETTERED', 'COALESCED'))`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("push_wakeups")
    .dropConstraint("push_wakeups_completion_check")
    .execute();
  await db.schema
    .alterTable("push_wakeups")
    .addCheckConstraint(
      "push_wakeups_completion_check",
      sql`(completed_at is null and outcome is null) or (completed_at is not null and outcome in ('SENT', 'INELIGIBLE', 'EXPIRED', 'INVALID_TOKEN', 'DEAD_LETTERED', 'COALESCED'))`,
    )
    .execute();
  await db.schema
    .alterTable("trip_members")
    .dropConstraint("trip_members_lifecycle_check")
    .execute();
  await db.schema
    .alterTable("trip_members")
    .addCheckConstraint(
      "trip_members_lifecycle_check",
      sql`
        (
          state = 'PENDING_KEY'
          and role = 'MEMBER'
          and key_epoch is null
          and approved_at is null
          and rejected_at is null
        ) or (
          state = 'ACTIVE'
          and key_epoch = 1
          and approved_at is not null
          and rejected_at is null
        ) or (
          state = 'REJECTED'
          and role = 'MEMBER'
          and key_epoch is null
          and approved_at is null
          and rejected_at is not null
        )
      `,
    )
    .execute();
}
