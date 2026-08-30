import { sql, type Kysely } from "kysely";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { migrateToLatest } from "../../services/control-plane/src/db/migrate.js";
import type { Database } from "../../services/control-plane/src/db/schema/tables.js";
import {
  createIdentityTripFixtures,
  type IdentityTripFixtures,
} from "./support/fixtures.js";
import { migrateDown } from "./support/migrations.js";
import {
  resolveExplicitExternalPostgresUrl,
  startMigratedPostgres,
  truncateIdentityTripTables,
  type PostgresTestContext,
  usesExplicitExternalPostgres,
} from "./support/postgres.js";

const FIXED_NOW = new Date("2026-08-29T08:00:00.000Z");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function expectPostgresError(
  operation: Promise<unknown>,
  expectedCode: "23503" | "23505" | "23514",
  expectedConstraint?: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected PostgreSQL error ${expectedCode}`);
  } catch (error) {
    expect(error).toMatchObject({
      code: expectedCode,
      ...(expectedConstraint === undefined
        ? {}
        : { constraint: expectedConstraint }),
    });
  }
}

describe.sequential("identity and trip schema", () => {
  let context: PostgresTestContext;
  let db: Kysely<Database>;
  let fixture: IdentityTripFixtures;

  beforeAll(async () => {
    context = await startMigratedPostgres();
    db = context.db;
  });

  beforeEach(async () => {
    await truncateIdentityTripTables(db);
    fixture = createIdentityTripFixtures(db);
  });

  afterAll(async () => {
    await context?.stop();
  });

  it("creates only the seven DB-001 identity/trip tables and required indexes", async () => {
    const tables = await sql<{ table_name: string }>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name not like 'kysely_%'
        and table_name in (
          'devices', 'trip_invites', 'trip_key_envelopes', 'trip_members',
          'trips', 'user_active_trips', 'users'
        )
      order by table_name
    `.execute(db);

    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "devices",
      "trip_invites",
      "trip_key_envelopes",
      "trip_members",
      "trips",
      "user_active_trips",
      "users",
    ]);

    const indexes = await sql<{ indexdef: string; indexname: string }>`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'devices_user_active_idx',
          'trip_members_trip_state_idx',
          'trips_state_ends_idx'
        )
      order by indexname
    `.execute(db);

    expect(indexes.rows).toHaveLength(3);
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "devices_user_active_idx",
      "trip_members_trip_state_idx",
      "trips_state_ends_idx",
    ]);
    expect(indexes.rows[0]?.indexdef).toContain("USING btree (user_id)");
    expect(indexes.rows[0]?.indexdef).toContain("WHERE (revoked_at IS NULL)");
    expect(indexes.rows[1]?.indexdef).toContain("USING btree (trip_id, state)");
    expect(indexes.rows[2]?.indexdef).toContain("USING btree (state, ends_at)");
  });

  it("installs every named DB-001 check constraint as validated", async () => {
    const constraints = await sql<{
      conname: string;
      convalidated: boolean;
    }>`
      select constraint_record.conname, constraint_record.convalidated
      from pg_constraint as constraint_record
      join pg_namespace as namespace_record
        on namespace_record.oid = constraint_record.connamespace
      where namespace_record.nspname = 'public'
        and constraint_record.contype = 'c'
        and constraint_record.conrelid in (
          'devices'::regclass, 'trip_invites'::regclass,
          'trip_key_envelopes'::regclass, 'trip_members'::regclass,
          'trips'::regclass, 'users'::regclass
        )
      order by constraint_record.conname
    `.execute(db);

    expect(constraints.rows.map(({ conname }) => conname)).toEqual([
      "devices_app_version_check",
      "devices_authentication_key_check",
      "devices_background_credential_check",
      "devices_e2ee_key_check",
      "devices_installation_id_check",
      "devices_platform_check",
      "devices_push_token_pair_check",
      "trip_invites_expiry_check",
      "trip_invites_hmac_check",
      "trip_invites_uses_check",
      "trip_key_envelopes_version_check",
      "trip_key_envelopes_wrapped_key_check",
      "trip_members_lifecycle_check",
      "trip_members_lifecycle_order_check",
      "trip_members_role_check",
      "trip_members_state_check",
      "trips_duration_check",
      "trips_hard_delete_at_check",
      "trips_lifecycle_check",
      "trips_lifecycle_order_check",
      "trips_member_count_check",
      "trips_name_check",
      "trips_release_fields_check",
      "trips_state_check",
      "trips_version_check",
      "users_clerk_subject_check",
      "users_display_name_check",
    ]);
    expect(constraints.rows.every(({ convalidated }) => convalidated)).toBe(
      true,
    );
  });

  it("declares every DB-001 foreign key with RESTRICT deletion", async () => {
    const constraints = await sql<{
      conname: string;
      delete_action: string;
    }>`
      select constraint_record.conname,
             constraint_record.confdeltype::text as delete_action
      from pg_constraint as constraint_record
      join pg_namespace as namespace_record
        on namespace_record.oid = constraint_record.connamespace
      where namespace_record.nspname = 'public'
        and constraint_record.contype = 'f'
        and constraint_record.conrelid in (
          'devices'::regclass, 'trip_invites'::regclass,
          'trip_key_envelopes'::regclass, 'trip_members'::regclass,
          'trips'::regclass, 'user_active_trips'::regclass
        )
      order by constraint_record.conname
    `.execute(db);

    expect(constraints.rows).toEqual([
      { conname: "devices_user_id_fk", delete_action: "r" },
      { conname: "trip_invites_trip_id_fk", delete_action: "r" },
      {
        conname: "trip_key_envelopes_recipient_member_fk",
        delete_action: "r",
      },
      {
        conname: "trip_key_envelopes_sender_member_fk",
        delete_action: "r",
      },
      { conname: "trip_key_envelopes_trip_id_fk", delete_action: "r" },
      { conname: "trip_members_trip_id_fk", delete_action: "r" },
      { conname: "trip_members_user_device_fk", delete_action: "r" },
      { conname: "trip_members_user_id_fk", delete_action: "r" },
      { conname: "trips_owner_user_id_fk", delete_action: "r" },
      { conname: "user_active_trips_trip_id_fk", delete_action: "r" },
      { conname: "user_active_trips_user_id_fk", delete_action: "r" },
    ]);
  });

  it("counts Unicode characters rather than bytes for user and trip names", async () => {
    const owner = await fixture.user({ display_name: "💙".repeat(80) });
    await fixture.trip(owner.id, { name: "🚀".repeat(80) });

    await expectPostgresError(
      fixture.user({ display_name: "💙".repeat(81) }),
      "23514",
    );
    await expectPostgresError(
      fixture.trip(owner.id, { name: "🚀".repeat(81) }),
      "23514",
    );
    await expectPostgresError(fixture.user({ display_name: "   " }), "23514");
  });

  it("defaults member readiness to false and persists explicit true", async () => {
    const owner = await fixture.user();
    const member = await fixture.user();
    const trip = await fixture.trip(owner.id);
    const device = await fixture.device(member.id);
    const membership = await fixture.member(trip.id, member.id, device.id);

    const defaulted = await sql<{ full_photo_library_access: boolean }>`
      select full_photo_library_access
      from trip_members
      where id = ${membership.id}::uuid
    `.execute(db);
    expect(defaulted.rows).toEqual([{ full_photo_library_access: false }]);

    const explicit = await sql<{ full_photo_library_access: boolean }>`
      update trip_members
      set full_photo_library_access = true
      where id = ${membership.id}::uuid
      returning full_photo_library_access
    `.execute(db);
    expect(explicit.rows).toEqual([{ full_photo_library_access: true }]);

    const column = await sql<{
      column_default: string;
      is_nullable: "NO" | "YES";
      udt_name: string;
    }>`
      select column_default, is_nullable, udt_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'trip_members'
        and column_name = 'full_photo_library_access'
    `.execute(db);
    expect(column.rows).toEqual([
      { column_default: "false", is_nullable: "NO", udt_name: "bool" },
    ]);
  });

  it("defaults trip version to one and rejects zero with the named check", async () => {
    const owner = await fixture.user();
    const endsAt = new Date(FIXED_NOW.getTime() + ONE_DAY_MS);
    const defaulted = await db
      .insertInto("trips")
      .values({
        cancelled_at: null,
        completed_at: null,
        created_at: FIXED_NOW,
        ending_started_at: null,
        ends_at: endsAt,
        hard_delete_at: new Date(endsAt.getTime() + 7 * ONE_DAY_MS),
        id: "018f0d98-76fa-7d1a-b4b4-1f742c2e3190",
        member_count: 1,
        name: "Default version",
        owner_user_id: owner.id,
        release_local_time: null,
        release_mode: "IMMEDIATE",
        release_timezone: null,
        started_at: null,
        state: "LOBBY",
        updated_at: FIXED_NOW,
      })
      .returning("version")
      .executeTakeFirstOrThrow();

    expect(defaulted.version).toBe(1);
    await fixture.trip(owner.id, { version: 1 });
    await expectPostgresError(
      fixture.trip(owner.id, { version: 0 }),
      "23514",
      "trips_version_check",
    );

    const catalog = await sql<{
      column_default: string;
      convalidated: boolean;
      definition: string;
    }>`
      select column_record.column_default,
             constraint_record.convalidated,
             pg_get_constraintdef(constraint_record.oid) as definition
      from information_schema.columns as column_record
      join pg_constraint as constraint_record
        on constraint_record.conrelid = 'trips'::regclass
       and constraint_record.conname = 'trips_version_check'
      where column_record.table_schema = 'public'
        and column_record.table_name = 'trips'
        and column_record.column_name = 'version'
    `.execute(db);
    expect(catalog.rows).toHaveLength(1);
    expect(catalog.rows[0]).toMatchObject({
      column_default: "1",
      convalidated: true,
    });
    expect(catalog.rows[0]!.definition).toContain("version >= 1");
  });

  it("keeps Clerk subjects, device installations, and credential hashes unique", async () => {
    const firstUser = await fixture.user({ clerk_subject: "user_subject" });
    const secondUser = await fixture.user();
    const firstDevice = await fixture.device(firstUser.id, {
      background_credential_hash: Uint8Array.from({ length: 32 }, () => 7),
      installation_id: "installation_stable",
    });

    await expectPostgresError(
      fixture.user({ clerk_subject: "user_subject" }),
      "23505",
    );
    await expectPostgresError(
      fixture.device(firstUser.id, {
        installation_id: firstDevice.installation_id,
      }),
      "23505",
    );
    await expectPostgresError(
      fixture.device(secondUser.id, {
        background_credential_hash: firstDevice.background_credential_hash,
      }),
      "23505",
    );
  });

  it("accepts installation IDs beginning with either allowed separator", async () => {
    const user = await fixture.user();

    await fixture.device(user.id, { installation_id: "_abc1234" });
    await fixture.device(user.id, { installation_id: "-abc1234" });
  });

  it.each(["device.01", "device:01"])(
    "rejects installation ID punctuation outside the canonical alphabet: %s",
    async (installationId) => {
      const user = await fixture.user();

      await expectPostgresError(
        fixture.device(user.id, { installation_id: installationId }),
        "23514",
      );
    },
  );

  it("keeps an installation ID globally unique across users", async () => {
    const firstUser = await fixture.user();
    const secondUser = await fixture.user();

    await fixture.device(firstUser.id, { installation_id: "shared_id" });
    await expectPostgresError(
      fixture.device(secondUser.id, { installation_id: "shared_id" }),
      "23505",
    );
  });

  it("rejects the remaining identity and device check boundaries", async () => {
    const user = await fixture.user();

    await expectPostgresError(fixture.user({ clerk_subject: "" }), "23514");
    await expectPostgresError(
      fixture.device(user.id, { authentication_key_version: 2 as 1 }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, {
        authentication_public_key: new Uint8Array(),
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, {
        authentication_public_key: new Uint8Array(1025),
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, { e2ee_key_algorithm: "P-256" as "X25519" }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, { e2ee_key_version: 2 as 1 }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, { e2ee_public_key: new Uint8Array(33) }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, {
        encrypted_push_token: Uint8Array.of(1),
        push_token_hash: new Uint8Array(31),
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, {
        encrypted_push_token: new Uint8Array(),
        push_token_hash: new Uint8Array(32),
      }),
      "23514",
    );
  });

  it("requires an exact uncompressed 65-byte P-256 authentication point shape", async () => {
    const user = await fixture.user();

    for (const authenticationPublicKey of [
      Uint8Array.from({ length: 64 }, (_, index) => (index === 0 ? 4 : 1)),
      Uint8Array.from({ length: 66 }, (_, index) => (index === 0 ? 4 : 1)),
      Uint8Array.from({ length: 65 }, () => 1),
    ]) {
      await expectPostgresError(
        fixture.device(user.id, {
          authentication_public_key: authenticationPublicKey,
        }),
        "23514",
        "devices_authentication_key_check",
      );
    }
  });

  it("rejects incoherent device key, push-token, and revocation data", async () => {
    const user = await fixture.user();

    await expectPostgresError(
      fixture.device(user.id, { platform: "windows" as "ios" }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, {
        authentication_key_algorithm: "RSA" as "P-256",
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, { installation_id: "bad path" }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, { app_version: "1x2x3" }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, {
        background_credential_hash: new Uint8Array(31),
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, {
        e2ee_public_key: Uint8Array.from({ length: 31 }, () => 1),
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, {
        encrypted_push_token: Uint8Array.of(1, 2, 3),
        push_token_hash: null,
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.device(user.id, {
        background_credential_expires_at: FIXED_NOW,
      }),
      "23514",
    );
  });

  it("enforces the stored ten-member boundary and fourteen-day trip limit", async () => {
    const owner = await fixture.user();
    const exactlyFourteenDays = new Date(FIXED_NOW.getTime() + 14 * ONE_DAY_MS);

    await fixture.trip(owner.id, {
      ends_at: exactlyFourteenDays,
      hard_delete_at: new Date(exactlyFourteenDays.getTime() + 7 * ONE_DAY_MS),
      member_count: 10,
    });

    await expectPostgresError(
      fixture.trip(owner.id, { member_count: 11 }),
      "23514",
    );
    await expectPostgresError(
      fixture.trip(owner.id, { member_count: 0 }),
      "23514",
    );

    const tooLate = new Date(exactlyFourteenDays.getTime() + 1);
    await expectPostgresError(
      fixture.trip(owner.id, {
        ends_at: tooLate,
        hard_delete_at: new Date(tooLate.getTime() + 7 * ONE_DAY_MS),
      }),
      "23514",
    );
  });

  it("requires hard deletion exactly seven days after the trip ends", async () => {
    const owner = await fixture.user();
    const endsAt = new Date(FIXED_NOW.getTime() + ONE_DAY_MS);

    await expectPostgresError(
      fixture.trip(owner.id, {
        ends_at: endsAt,
        hard_delete_at: new Date(endsAt.getTime() + 7 * ONE_DAY_MS - 1),
      }),
      "23514",
    );
  });

  it("keeps Immediate and Nightly release fields coherent", async () => {
    const owner = await fixture.user();

    await fixture.trip(owner.id, {
      release_local_time: "22:00:00",
      release_mode: "NIGHTLY",
      release_timezone: "Asia/Kolkata",
    });

    await expectPostgresError(
      fixture.trip(owner.id, {
        release_mode: "IMMEDIATE",
        release_timezone: "Asia/Kolkata",
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.trip(owner.id, {
        release_mode: "NIGHTLY",
        release_timezone: "Asia/Kolkata",
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.trip(owner.id, {
        release_local_time: "22:00:00",
        release_mode: "NIGHTLY",
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.trip(owner.id, {
        release_local_time: "22:00:01",
        release_mode: "NIGHTLY",
        release_timezone: "Asia/Kolkata",
      }),
      "23514",
    );
  });

  it("enforces all six trip lifecycle states and their timestamps", async () => {
    const owner = await fixture.user();

    await fixture.trip(owner.id, {
      started_at: FIXED_NOW,
      state: "ACTIVE",
    });
    await fixture.trip(owner.id, {
      ending_started_at: FIXED_NOW,
      started_at: FIXED_NOW,
      state: "ENDING",
    });
    await fixture.trip(owner.id, {
      completed_at: FIXED_NOW,
      ending_started_at: FIXED_NOW,
      started_at: FIXED_NOW,
      state: "COMPLETE",
    });
    await fixture.trip(owner.id, {
      completed_at: FIXED_NOW,
      ending_started_at: FIXED_NOW,
      started_at: FIXED_NOW,
      state: "INCOMPLETE_EXPIRED",
    });
    await fixture.trip(owner.id, {
      cancelled_at: FIXED_NOW,
      state: "CANCELLED",
    });

    await expectPostgresError(
      fixture.trip(owner.id, { state: "UNKNOWN" as "LOBBY" }),
      "23514",
    );
    await expectPostgresError(
      fixture.trip(owner.id, { state: "ACTIVE" }),
      "23514",
    );
    await expectPostgresError(
      fixture.trip(owner.id, {
        cancelled_at: FIXED_NOW,
        started_at: FIXED_NOW,
        state: "CANCELLED",
      }),
      "23514",
    );
  });

  it("rejects the remaining trip check boundaries", async () => {
    const owner = await fixture.user();
    const beforeCreation = new Date(FIXED_NOW.getTime() - 1);

    await expectPostgresError(fixture.trip(owner.id, { name: "   " }), "23514");
    await expectPostgresError(
      fixture.trip(owner.id, {
        ends_at: FIXED_NOW,
        hard_delete_at: new Date(FIXED_NOW.getTime() + 7 * ONE_DAY_MS),
      }),
      "23514",
    );
    await expectPostgresError(fixture.trip(owner.id, { version: -1 }), "23514");
    await expectPostgresError(
      fixture.trip(owner.id, {
        started_at: beforeCreation,
        state: "ACTIVE",
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.trip(owner.id, {
        ending_started_at: beforeCreation,
        started_at: FIXED_NOW,
        state: "ENDING",
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.trip(owner.id, {
        completed_at: beforeCreation,
        ending_started_at: FIXED_NOW,
        started_at: FIXED_NOW,
        state: "COMPLETE",
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.trip(owner.id, {
        cancelled_at: beforeCreation,
        state: "CANCELLED",
      }),
      "23514",
    );
  });

  it("allows one pending or active trip slot per user", async () => {
    const owner = await fixture.user();
    const first = await fixture.trip(owner.id);
    const second = await fixture.trip(owner.id);

    await fixture.activeTrip(owner.id, first.id);
    await expectPostgresError(fixture.activeTrip(owner.id, second.id), "23505");
  });

  it("bounds invite HMAC size, expiry, and use counters", async () => {
    const owner = await fixture.user();
    const trip = await fixture.trip(owner.id);
    const invite = await fixture.invite(trip.id, {
      invite_code_hmac: Uint8Array.from({ length: 32 }, () => 6),
    });

    await expectPostgresError(
      fixture.invite(trip.id, {
        invite_code_hmac: invite.invite_code_hmac,
      }),
      "23505",
    );
    await expectPostgresError(
      fixture.invite(trip.id, {
        invite_code_hmac: Uint8Array.of(1),
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.invite(trip.id, { max_uses: 10 }),
      "23514",
    );
    await expectPostgresError(
      fixture.invite(trip.id, { max_uses: 3, uses_count: 4 }),
      "23514",
    );
    await expectPostgresError(
      fixture.invite(trip.id, { expires_at: FIXED_NOW }),
      "23514",
    );
    await expectPostgresError(
      fixture.invite(trip.id, { max_uses: 0 }),
      "23514",
    );
    await expectPostgresError(
      fixture.invite(trip.id, { uses_count: -1 }),
      "23514",
    );
  });

  it("keeps one membership per user and device within a trip", async () => {
    const owner = await fixture.user();
    const member = await fixture.user();
    const other = await fixture.user();
    const trip = await fixture.trip(owner.id);
    const device = await fixture.device(member.id);
    const otherDevice = await fixture.device(other.id);

    await fixture.member(trip.id, member.id, device.id);
    await expectPostgresError(
      fixture.member(trip.id, member.id, otherDevice.id),
      "23505",
    );
    await expectPostgresError(
      fixture.member(trip.id, other.id, device.id),
      "23505",
    );
  });

  it("requires a membership device to belong to the same user", async () => {
    const owner = await fixture.user();
    const member = await fixture.user();
    const anotherUser = await fixture.user();
    const trip = await fixture.trip(owner.id);
    const anotherDevice = await fixture.device(anotherUser.id);

    await expectPostgresError(
      fixture.member(trip.id, member.id, anotherDevice.id),
      "23503",
    );
  });

  it("keeps membership state, key epoch, and lifecycle timestamps coherent", async () => {
    const owner = await fixture.user();
    const member = await fixture.user();
    const pending = await fixture.user();
    const rejected = await fixture.user();
    const trip = await fixture.trip(owner.id);
    const device = await fixture.device(member.id);
    const pendingDevice = await fixture.device(pending.id);
    const rejectedDevice = await fixture.device(rejected.id);

    await fixture.member(trip.id, pending.id, pendingDevice.id, {
      approved_at: null,
      key_epoch: null,
      state: "PENDING_KEY",
    });
    await fixture.member(trip.id, rejected.id, rejectedDevice.id, {
      approved_at: null,
      key_epoch: null,
      rejected_at: FIXED_NOW,
      state: "REJECTED",
    });

    await expectPostgresError(
      fixture.member(trip.id, member.id, device.id, {
        approved_at: null,
        key_epoch: null,
        role: "OWNER",
        state: "PENDING_KEY",
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.member(trip.id, member.id, device.id, {
        approved_at: null,
        key_epoch: null,
        state: "ACTIVE",
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.member(trip.id, member.id, device.id, {
        role: "ADMIN" as "MEMBER",
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.member(trip.id, member.id, device.id, {
        state: "UNKNOWN" as "ACTIVE",
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.member(trip.id, member.id, device.id, {
        approved_at: new Date(FIXED_NOW.getTime() - 1),
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.member(trip.id, member.id, device.id, {
        approved_at: null,
        key_epoch: null,
        rejected_at: new Date(FIXED_NOW.getTime() - 1),
        state: "REJECTED",
      }),
      "23514",
    );
  });

  it("enforces envelope uniqueness, membership FKs, versions, and byte bounds", async () => {
    const owner = await fixture.user();
    const recipient = await fixture.user();
    const outsider = await fixture.user();
    const trip = await fixture.trip(owner.id);
    const ownerDevice = await fixture.device(owner.id);
    const recipientDevice = await fixture.device(recipient.id);
    const outsiderDevice = await fixture.device(outsider.id);

    await fixture.member(trip.id, owner.id, ownerDevice.id, { role: "OWNER" });
    await fixture.member(trip.id, recipient.id, recipientDevice.id);
    await fixture.envelope(trip.id, recipientDevice.id, ownerDevice.id);

    await expectPostgresError(
      fixture.envelope(trip.id, recipientDevice.id, ownerDevice.id),
      "23505",
    );
    await expectPostgresError(
      fixture.envelope(trip.id, outsiderDevice.id, ownerDevice.id),
      "23503",
    );
    await expectPostgresError(
      fixture.envelope(trip.id, ownerDevice.id, outsiderDevice.id),
      "23503",
    );
    await expectPostgresError(
      fixture.envelope(trip.id, ownerDevice.id, recipientDevice.id, {
        algorithm_version: 2 as 1,
      }),
      "23514",
    );
    await expectPostgresError(
      fixture.envelope(trip.id, ownerDevice.id, recipientDevice.id, {
        wrapped_key: new Uint8Array(147),
      }),
      "23514",
      "trip_key_envelopes_wrapped_key_check",
    );
    await expectPostgresError(
      fixture.envelope(trip.id, ownerDevice.id, recipientDevice.id, {
        wrapped_key: new Uint8Array(149),
      }),
      "23514",
      "trip_key_envelopes_wrapped_key_check",
    );
  });

  it("requires envelope senders and recipients to be active in the same key epoch", async () => {
    const owner = await fixture.user();
    const pending = await fixture.user();
    const trip = await fixture.trip(owner.id);
    const ownerDevice = await fixture.device(owner.id);
    const pendingDevice = await fixture.device(pending.id);

    await fixture.member(trip.id, owner.id, ownerDevice.id, { role: "OWNER" });
    await fixture.member(trip.id, pending.id, pendingDevice.id, {
      approved_at: null,
      key_epoch: null,
      state: "PENDING_KEY",
    });

    await expectPostgresError(
      fixture.envelope(trip.id, pendingDevice.id, ownerDevice.id),
      "23503",
    );
    await expectPostgresError(
      fixture.envelope(trip.id, ownerDevice.id, pendingDevice.id),
      "23503",
    );
  });

  it("uses RESTRICT for identity and trip references", async () => {
    const owner = await fixture.user();
    await fixture.trip(owner.id);

    await expectPostgresError(
      db.deleteFrom("users").where("id", "=", owner.id).execute(),
      "23503",
    );
  });

  it("migrates up, down, and up again", async () => {
    await migrateDown(db);

    const readinessAfterFifthDown = await sql<{ column_name: string }>`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'trip_members'
        and column_name = 'full_photo_library_access'
    `.execute(db);
    const priorVersionDefault = await sql<{ column_default: string }>`
      select column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'trips'
        and column_name = 'version'
    `.execute(db);
    const priorTripChecks = await sql<{
      conname: string;
      convalidated: boolean;
      definition: string;
    }>`
      select constraint_record.conname,
             constraint_record.convalidated,
             pg_get_constraintdef(constraint_record.oid) as definition
      from pg_constraint as constraint_record
      where constraint_record.conname in (
        'trips_version_check',
        'trip_key_envelopes_wrapped_key_check'
      )
      order by constraint_record.conname
    `.execute(db);
    const retainedApi002Index = await sql<{ indexname: string }>`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname = 'api_idempotency_expires_at_idx'
    `.execute(db);
    const retainedApi002AuthenticationCheck = await sql<{
      definition: string;
    }>`
      select pg_get_constraintdef(constraint_record.oid) as definition
      from pg_constraint as constraint_record
      where constraint_record.conname = 'devices_authentication_key_check'
        and constraint_record.conrelid = 'devices'::regclass
    `.execute(db);

    expect(readinessAfterFifthDown.rows).toEqual([]);
    expect(priorVersionDefault.rows).toEqual([{ column_default: "0" }]);
    expect(priorTripChecks.rows).toHaveLength(2);
    expect(priorTripChecks.rows.every(({ convalidated }) => convalidated)).toBe(
      true,
    );
    expect(priorTripChecks.rows[0]).toMatchObject({
      conname: "trip_key_envelopes_wrapped_key_check",
    });
    expect(priorTripChecks.rows[0]!.definition).toContain(
      "octet_length(wrapped_key) >= 1",
    );
    expect(priorTripChecks.rows[0]!.definition).toContain(
      "octet_length(wrapped_key) <= 4096",
    );
    expect(priorTripChecks.rows[1]).toMatchObject({
      conname: "trips_version_check",
    });
    expect(priorTripChecks.rows[1]!.definition).toContain("version >= 0");
    expect(retainedApi002Index.rows).toEqual([
      { indexname: "api_idempotency_expires_at_idx" },
    ]);
    expect(retainedApi002AuthenticationCheck.rows).toHaveLength(1);
    expect(retainedApi002AuthenticationCheck.rows[0]!.definition).toContain(
      "octet_length(authentication_public_key) = 65",
    );

    await migrateDown(db);
    await migrateDown(db);
    await migrateDown(db);
    await migrateDown(db);

    const tablesAfterDown = await sql<{ table_name: string }>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name not like 'kysely_%'
        and table_name in (
          'devices', 'trip_invites', 'trip_key_envelopes', 'trip_members',
          'trips', 'user_active_trips', 'users'
        )
      order by table_name
    `.execute(db);
    const indexesAfterDown = await sql<{ indexname: string }>`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'devices_user_active_idx',
          'api_idempotency_expires_at_idx',
          'trip_members_trip_state_idx',
          'trips_state_ends_idx'
        )
      order by indexname
    `.execute(db);
    expect(tablesAfterDown.rows).toEqual([]);
    expect(indexesAfterDown.rows).toEqual([]);

    await migrateToLatest(db);

    const tablesAfterSecondUp = await sql<{ table_name: string }>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name not like 'kysely_%'
        and table_name in (
          'devices', 'trip_invites', 'trip_key_envelopes', 'trip_members',
          'trips', 'user_active_trips', 'users'
        )
      order by table_name
    `.execute(db);
    const indexesAfterSecondUp = await sql<{ indexname: string }>`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'devices_user_active_idx',
          'api_idempotency_expires_at_idx',
          'trip_members_trip_state_idx',
          'trips_state_ends_idx'
        )
      order by indexname
    `.execute(db);
    expect(
      tablesAfterSecondUp.rows.map(({ table_name }) => table_name),
    ).toEqual([
      "devices",
      "trip_invites",
      "trip_key_envelopes",
      "trip_members",
      "trips",
      "user_active_trips",
      "users",
    ]);
    expect(indexesAfterSecondUp.rows.map(({ indexname }) => indexname)).toEqual(
      [
        "api_idempotency_expires_at_idx",
        "devices_user_active_idx",
        "trip_members_trip_state_idx",
        "trips_state_ends_idx",
      ],
    );
    const restoredAuthenticationChecks = await sql<{ definition: string }>`
      select pg_get_constraintdef(constraint_record.oid) as definition
      from pg_constraint as constraint_record
      where constraint_record.conname = 'devices_authentication_key_check'
        and constraint_record.conrelid = 'devices'::regclass
    `.execute(db);
    expect(restoredAuthenticationChecks.rows).toHaveLength(1);
    expect(restoredAuthenticationChecks.rows[0]!.definition).toContain(
      "octet_length(authentication_public_key) = 65",
    );
    expect(restoredAuthenticationChecks.rows[0]!.definition).toContain(
      "get_byte(authentication_public_key, 0) = 4",
    );

    const restoredReadiness = await sql<{
      column_default: string;
      is_nullable: "NO" | "YES";
    }>`
      select column_default, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'trip_members'
        and column_name = 'full_photo_library_access'
    `.execute(db);
    const restoredVersionDefault = await sql<{ column_default: string }>`
      select column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'trips'
        and column_name = 'version'
    `.execute(db);
    const restoredTripChecks = await sql<{
      conname: string;
      convalidated: boolean;
      definition: string;
    }>`
      select constraint_record.conname,
             constraint_record.convalidated,
             pg_get_constraintdef(constraint_record.oid) as definition
      from pg_constraint as constraint_record
      where constraint_record.conname in (
        'trips_version_check',
        'trip_key_envelopes_wrapped_key_check'
      )
      order by constraint_record.conname
    `.execute(db);
    expect(restoredReadiness.rows).toEqual([
      { column_default: "false", is_nullable: "NO" },
    ]);
    expect(restoredVersionDefault.rows).toEqual([{ column_default: "1" }]);
    expect(
      restoredTripChecks.rows.every(({ convalidated }) => convalidated),
    ).toBe(true);
    expect(restoredTripChecks.rows[0]!.definition).toContain(
      "octet_length(wrapped_key) = 148",
    );
    expect(restoredTripChecks.rows[1]!.definition).toContain("version >= 1");
  });
});

describe.sequential("PostgreSQL test-support lifecycle", () => {
  it("fails closed unless the disposable loopback cluster is explicitly approved", () => {
    expect(resolveExplicitExternalPostgresUrl({})).toBeNull();
    expect(() =>
      resolveExplicitExternalPostgresUrl({
        CREWROLL_TEST_EXTERNAL_POSTGRES_URL:
          "postgresql://uankit@127.0.0.1:55432/postgres",
      }),
    ).toThrow("explicit disposable-loopback opt-in");
    expect(() =>
      resolveExplicitExternalPostgresUrl({
        CREWROLL_TEST_EXTERNAL_POSTGRES_OPT_IN: "DISPOSABLE_LOOPBACK_ONLY",
      }),
    ).toThrow("explicit disposable-loopback opt-in");

    for (const connectionString of [
      "postgresql://uankit@localhost:55433/postgres",
      "postgresql://uankit@127.0.0.1:5432/postgres",
      "postgresql://uankit@127.0.0.1:55434/postgres",
      "postgresql://uankit@127.0.0.1:55433/user_database",
      "postgresql://uankit@127.0.0.1:55433/postgres?sslmode=disable",
      "postgresql://uankit@127.0.0.1:55433/postgres#fragment",
    ]) {
      expect(() =>
        resolveExplicitExternalPostgresUrl({
          CREWROLL_TEST_EXTERNAL_POSTGRES_OPT_IN: "DISPOSABLE_LOOPBACK_ONLY",
          CREWROLL_TEST_EXTERNAL_POSTGRES_URL: connectionString,
        }),
      ).toThrow("approved disposable loopback cluster");
    }

    for (const connectionString of [
      "postgresql://uankit@127.0.0.1:55432/postgres",
      "postgresql://uankit@127.0.0.1:55432/crewroll_test_task4_green",
      "postgresql://uankit@127.0.0.1:55433/postgres",
      "postgresql://uankit@127.0.0.1:55433/crewroll_test_task4_green",
    ]) {
      expect(
        resolveExplicitExternalPostgresUrl({
          CREWROLL_TEST_EXTERNAL_POSTGRES_OPT_IN: "DISPOSABLE_LOOPBACK_ONLY",
          CREWROLL_TEST_EXTERNAL_POSTGRES_URL: connectionString,
        }),
      ).toBe(connectionString);
    }
  });

  it("cleans test resources when database construction fails", async () => {
    const failure = new Error("database construction failed for test");

    if (usesExplicitExternalPostgres()) {
      let observedError: unknown;

      try {
        await startMigratedPostgres({
          databaseFactory() {
            throw failure;
          },
        });
      } catch (error) {
        observedError = error;
      }

      expect(observedError).toBe(failure);
      return;
    }

    let containerId: string | undefined;
    let unexpectedContext: PostgresTestContext | undefined;
    let observedError: unknown;

    try {
      unexpectedContext = await startMigratedPostgres({
        databaseFactory() {
          throw failure;
        },
        onContainerStarted(container) {
          containerId = container.getId();
        },
      });
    } catch (error) {
      observedError = error;
    } finally {
      await unexpectedContext?.stop();
    }

    expect(observedError).toBe(failure);
    expect(containerId).toEqual(expect.any(String));

    const runtime = await getContainerRuntimeClient();
    const runningContainers = await runtime.container.list();
    expect(runningContainers.some(({ Id: id }) => id === containerId)).toBe(
      false,
    );
  });
});
