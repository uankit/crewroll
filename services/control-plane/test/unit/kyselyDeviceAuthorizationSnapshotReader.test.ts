import { describe, expect, it } from "vitest";

import { createKyselyDeviceAuthorizationSnapshotReader } from "../../src/db/devices/kyselyDeviceAuthorizationSnapshotReader.js";
import { registrationCommandIdentity } from "../../src/modules/devices/requestFingerprint.js";
import { validRegisterDeviceBody } from "@crewroll/contracts/fixtures/http";

const deviceProjection = [
  "id",
  "user_id",
  "platform",
  "authentication_key_algorithm",
  "authentication_key_version",
  "authentication_public_key",
  "e2ee_key_algorithm",
  "e2ee_key_version",
  "e2ee_public_key",
  "push_token_hash",
  "revoked_at",
] as const;

describe("Kysely device authorization snapshot reader", () => {
  it("selects and returns only registration preauthorization fields", async () => {
    const selected = new Map<string, readonly string[]>();
    const selectAllTables: string[] = [];
    const rows = {
      api_idempotency: undefined,
      devices: {
        app_version: "secret-app-canary",
        authentication_key_algorithm: "P-256",
        authentication_key_version: 1,
        authentication_public_key: Buffer.alloc(65),
        background_credential_expires_at: new Date("2026-09-29T00:00:00Z"),
        background_credential_hash: Buffer.alloc(32, 1),
        e2ee_key_algorithm: "X25519",
        e2ee_key_version: 1,
        e2ee_public_key: Buffer.alloc(32),
        encrypted_push_token: Buffer.from("secret-ciphertext-canary"),
        id: "018f0d98-76fa-7d1a-b4b4-1f742c2e3120",
        installation_id: "install_projection_canary",
        last_seen_at: new Date("2026-08-30T00:00:00Z"),
        platform: "ios",
        push_token_hash: Buffer.alloc(32, 2),
        revoked_at: null,
        user_id: "018f0d98-76fa-7d1a-b4b4-1f742c2e3110",
      },
      users: {
        deleted_at: null,
        id: "018f0d98-76fa-7d1a-b4b4-1f742c2e3110",
      },
    } as const;
    const database = {
      selectFrom(table: keyof typeof rows) {
        const builder = {
          executeTakeFirst: () => Promise.resolve(rows[table]),
          select(columns: readonly string[]) {
            selected.set(table, columns);
            return builder;
          },
          selectAll() {
            selectAllTables.push(table);
            return builder;
          },
          where() {
            return builder;
          },
        };
        return builder;
      },
    } as unknown as Parameters<
      typeof createKyselyDeviceAuthorizationSnapshotReader
    >[0];
    const reader = createKyselyDeviceAuthorizationSnapshotReader(database);

    const snapshot = await reader.readRegistration(
      "projection_subject",
      "install_projection_canary",
      registrationCommandIdentity(
        validRegisterDeviceBody(),
        "018f0d98-76fa-7d1a-b4b4-1f742c2e3170",
      ),
      new Date("2026-08-30T00:00:00Z"),
    );

    expect(selectAllTables).toEqual([]);
    expect(selected.get("devices")).toEqual(deviceProjection);
    expect(snapshot.installation).toEqual({
      authenticationKeyAlgorithm: "P-256",
      authenticationKeyVersion: 1,
      authenticationPublicKey: Buffer.alloc(65),
      deviceId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3120",
      e2eeKeyAlgorithm: "X25519",
      e2eeKeyVersion: 1,
      e2eePublicKey: Buffer.alloc(32),
      platform: "ios",
      pushTokenHash: Buffer.alloc(32, 2),
      revoked: false,
      userId: "018f0d98-76fa-7d1a-b4b4-1f742c2e3110",
    });
  });
});
