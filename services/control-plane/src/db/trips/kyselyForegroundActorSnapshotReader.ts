import type { Kysely } from "kysely";

import type { Database } from "../schema/tables.js";
import type {
  ForegroundActorSnapshot,
  ForegroundActorSnapshotReader,
} from "../../modules/trips/ports/foregroundActorSnapshotReader.js";

export function createKyselyForegroundActorSnapshotReader(
  database: Kysely<Database>,
): ForegroundActorSnapshotReader {
  return {
    async read({ clerkSubject, deviceId }): Promise<ForegroundActorSnapshot> {
      const row = await database
        .selectFrom("users")
        .leftJoin("devices", (join) =>
          join
            .onRef("devices.user_id", "=", "users.id")
            .on("devices.id", "=", deviceId),
        )
        .select([
          "users.id as user_id",
          "users.deleted_at as user_deleted_at",
          "devices.id as device_id",
          "devices.revoked_at as device_revoked_at",
        ])
        .where("users.clerk_subject", "=", clerkSubject)
        .executeTakeFirst();

      if (row === undefined || row.user_deleted_at !== null) {
        return { kind: "AUTH_INVALID" };
      }
      if (row.device_id === null) return { kind: "DEVICE_NOT_OWNED" };
      if (row.device_revoked_at !== null) return { kind: "DEVICE_REVOKED" };
      return {
        actor: {
          clerkSubject,
          deviceId: row.device_id,
          userId: row.user_id,
        },
        kind: "ACTIVE",
      };
    },
  };
}
