import { sql, type Kysely, type Transaction } from "kysely";

import type { Database } from "../schema/tables.js";
import { classifyDeviceConstraint } from "./constraintClassifier.js";

type DevicePlatform = "android" | "ios";
type RouteKey =
  "devices.push-token.patch.v1" | "devices.register.v1" | "devices.revoke.v1";

interface CommandIdentity {
  readonly idempotencyKey: string;
  readonly requestSha256: Readonly<Uint8Array>;
  readonly routeKey: RouteKey;
}

interface LocalUserRecord {
  readonly clerkSubject: string;
  readonly deleted: boolean;
  readonly displayName: string;
  readonly userId: string;
}

interface DeviceRecord {
  readonly appVersion: string;
  readonly authenticationKeyAlgorithm: "P-256";
  readonly authenticationKeyVersion: 1;
  readonly authenticationPublicKey: Readonly<Uint8Array>;
  readonly backgroundCredentialExpiresAt: Date;
  readonly backgroundCredentialHash: Readonly<Uint8Array>;
  readonly deviceId: string;
  readonly e2eeKeyAlgorithm: "X25519";
  readonly e2eeKeyVersion: 1;
  readonly e2eePublicKey: Readonly<Uint8Array>;
  readonly encryptedPushToken: Readonly<Uint8Array> | null;
  readonly installationId: string;
  readonly lastSeenAt: Date;
  readonly platform: DevicePlatform;
  readonly pushTokenHash: Readonly<Uint8Array> | null;
  readonly revoked: boolean;
  readonly userId: string;
}

interface DeviceIdempotencyRecord {
  readonly command: CommandIdentity;
  readonly expiresAt: Date;
  readonly responseBody: Readonly<Record<string, unknown>>;
  readonly responseStatus: number;
  readonly userId: string;
}

interface BackgroundAuthenticationRecord {
  readonly device: DeviceRecord;
  readonly userDeleted: boolean;
}

interface DeviceTransaction {
  deleteIdempotency(record: DeviceIdempotencyRecord): Promise<void>;
  findDeviceByInstallation(
    installationId: string,
  ): Promise<DeviceRecord | null>;
  findDeviceByOwnerAndId(
    userId: string,
    deviceId: string,
  ): Promise<DeviceRecord | null>;
  findDeviceByBackgroundCredentialHash(
    credentialHash: Readonly<Uint8Array>,
  ): Promise<BackgroundAuthenticationRecord | null>;
  findIdempotency(
    command: CommandIdentity,
    userId: string,
  ): Promise<DeviceIdempotencyRecord | null>;
  findUserByClerkSubject(clerkSubject: string): Promise<LocalUserRecord | null>;
  insertDevice(device: DeviceRecord): Promise<DeviceRecord>;
  insertUser(user: LocalUserRecord): Promise<LocalUserRecord>;
  pruneExpiredIdempotency(
    now: Date,
    excluding: CommandIdentity,
    userId: string,
    limit: 100,
  ): Promise<number>;
  updateDevice(device: DeviceRecord): Promise<DeviceRecord>;
  writeIdempotency(record: DeviceIdempotencyRecord): Promise<void>;
}

interface DeviceUnitOfWork {
  run<Result>(
    operation: (transaction: DeviceTransaction) => Promise<Result>,
  ): Promise<Result>;
}

function mapUser(row: {
  clerk_subject: string;
  deleted_at: Date | null;
  display_name: string;
  id: string;
}): LocalUserRecord {
  return {
    clerkSubject: row.clerk_subject,
    deleted: row.deleted_at !== null,
    displayName: row.display_name,
    userId: row.id,
  };
}

function mapDevice(row: {
  app_version: string;
  authentication_key_algorithm: "P-256";
  authentication_key_version: 1;
  authentication_public_key: Uint8Array;
  background_credential_expires_at: Date;
  background_credential_hash: Uint8Array;
  e2ee_key_algorithm: "X25519";
  e2ee_key_version: 1;
  e2ee_public_key: Uint8Array;
  encrypted_push_token: Uint8Array | null;
  id: string;
  installation_id: string;
  last_seen_at: Date;
  platform: "android" | "ios";
  push_token_hash: Uint8Array | null;
  revoked_at: Date | null;
  user_id: string;
}): DeviceRecord {
  return {
    appVersion: row.app_version,
    authenticationKeyAlgorithm: row.authentication_key_algorithm,
    authenticationKeyVersion: row.authentication_key_version,
    authenticationPublicKey: row.authentication_public_key,
    backgroundCredentialExpiresAt: row.background_credential_expires_at,
    backgroundCredentialHash: row.background_credential_hash,
    deviceId: row.id,
    e2eeKeyAlgorithm: row.e2ee_key_algorithm,
    e2eeKeyVersion: row.e2ee_key_version,
    e2eePublicKey: row.e2ee_public_key,
    encryptedPushToken: row.encrypted_push_token,
    installationId: row.installation_id,
    lastSeenAt: row.last_seen_at,
    platform: row.platform,
    pushTokenHash: row.push_token_hash,
    revoked: row.revoked_at !== null,
    userId: row.user_id,
  };
}

function mapIdempotency(row: {
  expires_at: Date;
  idempotency_key: string;
  request_sha256: Uint8Array;
  response_body: Readonly<Record<string, unknown>>;
  response_status: number;
  route_key: string;
  user_id: string;
}): DeviceIdempotencyRecord {
  return {
    command: {
      idempotencyKey: row.idempotency_key,
      requestSha256: row.request_sha256,
      routeKey: row.route_key as RouteKey,
    },
    expiresAt: row.expires_at,
    responseBody: row.response_body,
    responseStatus: row.response_status,
    userId: row.user_id,
  };
}

function transactionAdapter(
  transaction: Transaction<Database>,
): DeviceTransaction {
  return {
    async deleteIdempotency(record) {
      await transaction
        .deleteFrom("api_idempotency")
        .where("user_id", "=", record.userId)
        .where("route_key", "=", record.command.routeKey)
        .where("idempotency_key", "=", record.command.idempotencyKey)
        .executeTakeFirst();
    },
    async findDeviceByInstallation(installationId) {
      const row = await transaction
        .selectFrom("devices")
        .selectAll()
        .where("installation_id", "=", installationId)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : mapDevice(row);
    },
    async findDeviceByBackgroundCredentialHash(credentialHash) {
      // Resolve only the owner first. Locking a devices/users join lets the
      // query planner choose device-first, opposite to registration/media work.
      const candidate = await transaction
        .selectFrom("devices")
        .select(["id", "user_id"])
        .where("background_credential_hash", "=", Buffer.from(credentialHash))
        .executeTakeFirst();
      if (!candidate) return null;
      const user = await transaction
        .selectFrom("users")
        .select("deleted_at")
        .where("id", "=", candidate.user_id)
        .forUpdate()
        .executeTakeFirst();
      if (!user) return null;
      // Recheck the credential after acquiring locks: it may have been rotated
      // or revoked while the candidate read waited for its owner.
      const row = await transaction
        .selectFrom("devices")
        .selectAll()
        .where("id", "=", candidate.id)
        .where("user_id", "=", candidate.user_id)
        .where("background_credential_hash", "=", Buffer.from(credentialHash))
        .forUpdate()
        .executeTakeFirst();
      return row === undefined
        ? null
        : {
            device: mapDevice(row),
            userDeleted: user.deleted_at !== null,
          };
    },
    async findDeviceByOwnerAndId(userId, deviceId) {
      const row = await transaction
        .selectFrom("devices")
        .selectAll()
        .where("user_id", "=", userId)
        .where("id", "=", deviceId)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : mapDevice(row);
    },
    async findIdempotency(command, userId) {
      const row = await transaction
        .selectFrom("api_idempotency")
        .selectAll()
        .where("user_id", "=", userId)
        .where("route_key", "=", command.routeKey)
        .where("idempotency_key", "=", command.idempotencyKey)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : mapIdempotency(row);
    },
    async findUserByClerkSubject(clerkSubject) {
      const row = await transaction
        .selectFrom("users")
        .select(["id", "clerk_subject", "display_name", "deleted_at"])
        .where("clerk_subject", "=", clerkSubject)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : mapUser(row);
    },
    async insertDevice(device) {
      const row = await transaction
        .insertInto("devices")
        .values({
          app_version: device.appVersion,
          authentication_key_algorithm: device.authenticationKeyAlgorithm,
          authentication_key_version: device.authenticationKeyVersion,
          authentication_public_key: Buffer.from(
            device.authenticationPublicKey,
          ),
          background_credential_expires_at:
            device.backgroundCredentialExpiresAt,
          background_credential_hash: Buffer.from(
            device.backgroundCredentialHash,
          ),
          e2ee_key_algorithm: device.e2eeKeyAlgorithm,
          e2ee_key_version: device.e2eeKeyVersion,
          e2ee_public_key: Buffer.from(device.e2eePublicKey),
          encrypted_push_token:
            device.encryptedPushToken === null
              ? null
              : Buffer.from(device.encryptedPushToken),
          id: device.deviceId,
          installation_id: device.installationId,
          last_seen_at: device.lastSeenAt,
          platform: device.platform,
          push_token_hash:
            device.pushTokenHash === null
              ? null
              : Buffer.from(device.pushTokenHash),
          revoked_at: device.revoked ? device.lastSeenAt : null,
          user_id: device.userId,
          updated_at: device.lastSeenAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return mapDevice(row);
    },
    async insertUser(user) {
      const row = await transaction
        .insertInto("users")
        .values({
          clerk_subject: user.clerkSubject,
          deleted_at: user.deleted ? new Date() : null,
          display_name: user.displayName,
          id: user.userId,
        })
        .returning(["id", "clerk_subject", "display_name", "deleted_at"])
        .executeTakeFirstOrThrow();
      return mapUser(row);
    },
    async pruneExpiredIdempotency(now, excluding, userId, limit) {
      if (limit !== 100) throw new Error("Idempotency prune limit must be 100");
      const result = await sql<{ deleted: number }>`
        with candidates as (
          select user_id, route_key, idempotency_key
          from api_idempotency
          where expires_at <= ${now}
            and not (
              user_id = ${userId}::uuid
              and route_key = ${excluding.routeKey}
              and idempotency_key = ${excluding.idempotencyKey}::uuid
            )
          order by expires_at, user_id, route_key, idempotency_key
          for update skip locked
          limit ${limit}
        ), deleted as (
          delete from api_idempotency target
          using candidates
          where target.user_id = candidates.user_id
            and target.route_key = candidates.route_key
            and target.idempotency_key = candidates.idempotency_key
          returning 1
        )
        select count(*)::integer as deleted from deleted
      `.execute(transaction);
      return result.rows[0]?.deleted ?? 0;
    },
    async updateDevice(device) {
      const row = await transaction
        .updateTable("devices")
        .set({
          app_version: device.appVersion,
          authentication_key_algorithm: device.authenticationKeyAlgorithm,
          authentication_key_version: device.authenticationKeyVersion,
          authentication_public_key: Buffer.from(
            device.authenticationPublicKey,
          ),
          background_credential_expires_at:
            device.backgroundCredentialExpiresAt,
          background_credential_hash: Buffer.from(
            device.backgroundCredentialHash,
          ),
          e2ee_key_algorithm: device.e2eeKeyAlgorithm,
          e2ee_key_version: device.e2eeKeyVersion,
          e2ee_public_key: Buffer.from(device.e2eePublicKey),
          encrypted_push_token:
            device.encryptedPushToken === null
              ? null
              : Buffer.from(device.encryptedPushToken),
          last_seen_at: device.lastSeenAt,
          platform: device.platform,
          push_token_hash:
            device.pushTokenHash === null
              ? null
              : Buffer.from(device.pushTokenHash),
          revoked_at: device.revoked ? device.lastSeenAt : null,
          updated_at: device.lastSeenAt,
        })
        .where("id", "=", device.deviceId)
        .where("user_id", "=", device.userId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return mapDevice(row);
    },
    async writeIdempotency(record) {
      await transaction
        .insertInto("api_idempotency")
        .values({
          expires_at: record.expiresAt,
          idempotency_key: record.command.idempotencyKey,
          request_sha256: Buffer.from(record.command.requestSha256),
          response_body: record.responseBody,
          response_status: record.responseStatus,
          route_key: record.command.routeKey,
          user_id: record.userId,
        })
        .executeTakeFirst();
    },
  };
}

export function createKyselyDeviceUnitOfWork(
  database: Kysely<Database>,
): DeviceUnitOfWork {
  return {
    async run<Result>(
      operation: (deviceTransaction: DeviceTransaction) => Promise<Result>,
    ): Promise<Result> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await database
            .transaction()
            .execute((transaction) =>
              operation(transactionAdapter(transaction)),
            );
        } catch (error) {
          if (
            attempt >= 2 ||
            classifyDeviceConstraint(error) !== "retryable-unique-race"
          ) {
            throw error;
          }
        }
      }
    },
  };
}
