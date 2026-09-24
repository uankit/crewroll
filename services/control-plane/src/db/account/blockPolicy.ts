import { sql, type Transaction } from "kysely";
import type { Database } from "../schema/tables.js";
import { DomainError } from "../../shared/errors/domainError.js";

// The caller holds the trip lock, shared with block/leave, so approval cannot
// reintroduce a blocked pair while one member is leaving.
export async function requireUnblockedTrip(
  tx: Transaction<Database>,
  tripId: string,
  userId: string,
) {
  const result = await sql`select 1 from user_blocks b join trip_members m
    on (b.user_id = ${userId}::uuid and b.blocked_user_id = m.user_id)
    or (b.blocked_user_id = ${userId}::uuid and b.user_id = m.user_id)
    where m.trip_id = ${tripId}::uuid and m.left_at is null and m.state <> 'REJECTED' limit 1`.execute(
    tx,
  );
  if (result.rows.length) throw new DomainError("INVITE_INVALID");
}
