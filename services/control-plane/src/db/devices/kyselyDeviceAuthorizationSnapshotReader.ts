import type { Kysely } from "kysely";

import type { Database } from "../schema/tables.js";

type RouteKey =
  "devices.push-token.patch.v1" | "devices.register.v1" | "devices.revoke.v1";
type IdempotencySnapshotState =
  "expired" | "live-conflict" | "live-match" | "missing";
interface CommandIdentity {
  readonly idempotencyKey: string;
  readonly requestSha256: Readonly<Uint8Array>;
  readonly routeKey: RouteKey;
}

function idempotencyState(
  row: { expires_at: Date; request_sha256: Uint8Array } | undefined,
  command: CommandIdentity,
  now: Date,
): IdempotencySnapshotState {
  if (row === undefined) return "missing";
  if (row.expires_at.getTime() <= now.getTime()) return "expired";
  return Buffer.from(row.request_sha256).equals(
    Buffer.from(command.requestSha256),
  )
    ? "live-match"
    : "live-conflict";
}

export function createKyselyDeviceAuthorizationSnapshotReader(
  database: Kysely<Database>,
) {
  return {
    async readForegroundDevice(
      clerkSubject: string,
      deviceId: string,
      command: CommandIdentity,
      now: Date,
    ) {
      const row = await database
        .selectFrom("users")
        .innerJoin("devices", "devices.user_id", "users.id")
        .select([
          "users.id as user_id",
          "users.deleted_at as user_deleted_at",
          "devices.id as device_id",
          "devices.platform",
          "devices.push_token_hash",
          "devices.revoked_at",
        ])
        .where("users.clerk_subject", "=", clerkSubject)
        .where("devices.id", "=", deviceId)
        .executeTakeFirst();
      if (row === undefined) return null;
      const idempotency = await database
        .selectFrom("api_idempotency")
        .select(["expires_at", "request_sha256"])
        .where("user_id", "=", row.user_id)
        .where("route_key", "=", command.routeKey)
        .where("idempotency_key", "=", command.idempotencyKey)
        .executeTakeFirst();
      return {
        deviceId: row.device_id,
        idempotency: idempotencyState(idempotency, command, now),
        platform: row.platform,
        pushTokenHash: row.push_token_hash,
        revoked: row.revoked_at !== null,
        userDeleted: row.user_deleted_at !== null,
        userId: row.user_id,
      };
    },
    async readRegistration(
      clerkSubject: string,
      installationId: string,
      command: CommandIdentity,
      now: Date,
    ) {
      const [userRow, deviceRow] = await Promise.all([
        database
          .selectFrom("users")
          .select(["id", "deleted_at"])
          .where("clerk_subject", "=", clerkSubject)
          .executeTakeFirst(),
        database
          .selectFrom("devices")
          .selectAll()
          .where("installation_id", "=", installationId)
          .executeTakeFirst(),
      ]);
      const idempotency =
        userRow === undefined
          ? undefined
          : await database
              .selectFrom("api_idempotency")
              .select(["expires_at", "request_sha256"])
              .where("user_id", "=", userRow.id)
              .where("route_key", "=", command.routeKey)
              .where("idempotency_key", "=", command.idempotencyKey)
              .executeTakeFirst();
      return {
        idempotency: idempotencyState(idempotency, command, now),
        installation:
          deviceRow === undefined
            ? null
            : {
                authenticationKeyAlgorithm:
                  deviceRow.authentication_key_algorithm,
                authenticationKeyVersion: deviceRow.authentication_key_version,
                authenticationPublicKey: deviceRow.authentication_public_key,
                backgroundCredentialExpiresAt:
                  deviceRow.background_credential_expires_at,
                backgroundCredentialHash: deviceRow.background_credential_hash,
                deviceId: deviceRow.id,
                e2eeKeyAlgorithm: deviceRow.e2ee_key_algorithm,
                e2eeKeyVersion: deviceRow.e2ee_key_version,
                e2eePublicKey: deviceRow.e2ee_public_key,
                platform: deviceRow.platform,
                pushTokenHash: deviceRow.push_token_hash,
                revoked: deviceRow.revoked_at !== null,
                userId: deviceRow.user_id,
              },
        user:
          userRow === undefined
            ? ({ state: "absent" } as const)
            : {
                state:
                  userRow.deleted_at === null
                    ? ("active" as const)
                    : ("deleted" as const),
                userId: userRow.id,
              },
      };
    },
  };
}
