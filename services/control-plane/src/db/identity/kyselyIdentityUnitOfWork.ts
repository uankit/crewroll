import { sql, type Kysely } from "kysely";

import type { IdentityUnitOfWork } from "../../modules/identity/ports/identityUnitOfWork.js";
import { DomainError } from "../../shared/errors/domainError.js";
import type { Database } from "../schema/tables.js";

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
): IdentityUnitOfWork {
  return {
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
            await transaction
              .updateTable("devices")
              .set({
                encrypted_push_token: null,
                push_token_hash: null,
                revoked_at: sql`coalesce(revoked_at, ${now})`,
                updated_at: sql`case when revoked_at is null then ${now} else updated_at end`,
              })
              .where("user_id", "=", userId)
              .execute();
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
