import { sql, type Kysely } from "kysely";

import type { IdentityUnitOfWork } from "../../modules/identity/ports/identityUnitOfWork.js";
import type { ProfileRepository } from "../../modules/identity/ports/profileRepository.js";
import { DomainError } from "../../shared/errors/domainError.js";
import type { Database } from "../schema/tables.js";
import {
  enqueueAccountDeletion,
  subjectHash,
} from "../account/accountDeletion.js";

function isEventRace(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly constraint?: unknown;
  };
  return (
    candidate.code === "23505" &&
    candidate.constraint === "clerk_webhook_events_pkey"
  );
}

export function createKyselyIdentityUnitOfWork(
  database: Kysely<Database>,
): IdentityUnitOfWork & ProfileRepository {
  return {
    async synchronizeProfile(clerkSubject, displayName, candidateUserId, now) {
      const result = await sql<{ id: string }>`
        insert into users (id, clerk_subject, display_name, created_at, updated_at, deleted_at)
        select ${candidateUserId}::uuid, ${clerkSubject}, ${displayName}, ${now}, ${now}, null
        where not exists (select 1 from account_deleted_subjects where subject_hash = ${await subjectHash(clerkSubject)})
        on conflict (clerk_subject) do update set display_name = excluded.display_name, updated_at = excluded.updated_at
        where users.deleted_at is null
        returning id
      `.execute(database);
      if (!result.rows[0]) throw new DomainError("AUTH_INVALID");
    },
    async applyWebhook(event, candidateUserId, now) {
      try {
        return await database.transaction().execute(async (transaction) => {
          const existing = await transaction
            .selectFrom("clerk_webhook_events")
            .select("event_type")
            .where("event_id", "=", event.eventId)
            .forUpdate()
            .executeTakeFirst();
          if (existing !== undefined) {
            if (existing.event_type !== event.eventType) {
              throw new DomainError("CONFLICT");
            }
            return "replay" as const;
          }
          await transaction
            .insertInto("clerk_webhook_events")
            .values({
              event_id: event.eventId,
              event_type: event.eventType,
              processed_at: now,
            })
            .execute();

          if (
            event.eventType === "user.updated" &&
            event.clerkSubject !== null &&
            event.displayName !== null
          ) {
            await transaction
              .updateTable("users")
              .set({ display_name: event.displayName, updated_at: now })
              .where("clerk_subject", "=", event.clerkSubject)
              .where("deleted_at", "is", null)
              .execute();
          } else if (
            event.eventType === "user.deleted" &&
            event.clerkSubject !== null
          ) {
            if (candidateUserId === null)
              throw new DomainError("INTERNAL_ERROR");
            const finished = await transaction
              .selectFrom("account_deleted_subjects")
              .select("subject_hash")
              .where("subject_hash", "=", await subjectHash(event.clerkSubject))
              .executeTakeFirst();
            if (finished) {
              await transaction
                .updateTable("account_deletions")
                .set({ provider_deleted_at: now })
                .where("clerk_subject", "=", event.clerkSubject)
                .execute();
              return "applied" as const;
            }
            const result = await sql<{ id: string }>`
              insert into users (
                id, clerk_subject, display_name, created_at, updated_at, deleted_at
              ) values (
                ${candidateUserId}::uuid,
                ${event.clerkSubject},
                'CrewRoll member',
                ${now},
                ${now},
                ${now}
              )
              on conflict (clerk_subject) do update set
                deleted_at = coalesce(users.deleted_at, excluded.deleted_at),
                updated_at = case
                  when users.deleted_at is null then excluded.updated_at
                  else users.updated_at
                end
              returning id
            `.execute(transaction);
            const userId = result.rows[0]?.id;
            if (userId === undefined) throw new DomainError("INTERNAL_ERROR");
            await enqueueAccountDeletion(
              transaction,
              userId,
              event.clerkSubject,
              now,
              true,
            );
          }
          return "applied" as const;
        });
      } catch (error) {
        if (!isEventRace(error)) throw error;
        const winner = await database
          .selectFrom("clerk_webhook_events")
          .select("event_type")
          .where("event_id", "=", event.eventId)
          .executeTakeFirst();
        if (winner?.event_type === event.eventType) return "replay";
        if (winner !== undefined) throw new DomainError("CONFLICT");
        throw error;
      }
    },
  };
}
