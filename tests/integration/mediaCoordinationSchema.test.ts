import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../services/control-plane/src/db/schema/tables.js";
import { migrateToLatest } from "../../services/control-plane/src/db/migrate.js";
import {
  createMediaCoordinationFixtures,
  fixedBytes,
  FIXED_NOW,
  ONE_HOUR_MS,
  type MediaCoordinationFixtures,
} from "./support/mediaFixtures.js";
import { migrateDown } from "./support/migrations.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
  type PostgresTestContext,
} from "./support/postgres.js";

async function expectPostgresError(
  operation: Promise<unknown>,
  expected: Readonly<{
    code: "23502" | "23503" | "23505" | "23514";
    column?: string;
    constraint?: string;
  }>,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected PostgreSQL error ${expected.code}`);
  } catch (error) {
    expect(error).toMatchObject(expected);
  }
}

describe.sequential("media and coordination schema", () => {
  let context: PostgresTestContext;
  let db: Kysely<Database>;
  let fixture: MediaCoordinationFixtures;

  beforeAll(async () => {
    context = await startMigratedPostgres();
    db = context.db;
  });

  beforeEach(async () => {
    await truncateIdentityTripTables(db);
    fixture = createMediaCoordinationFixtures(db);
  });

  afterAll(async () => {
    await context?.stop();
  });

  it("creates every Task 4 media and coordination table", async () => {
    const tables = await sql<{ table_name: string }>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'upload_sessions',
          'upload_objects',
          'assets',
          'asset_objects',
          'deliveries',
          'receipts',
          'inbox_events',
          'outbox_events',
          'api_idempotency',
          'audit_events',
          'clerk_webhook_events'
        )
      order by table_name
    `.execute(db);

    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "api_idempotency",
      "asset_objects",
      "assets",
      "audit_events",
      "clerk_webhook_events",
      "deliveries",
      "inbox_events",
      "outbox_events",
      "receipts",
      "upload_objects",
      "upload_sessions",
    ]);
  });

  it("installs the exact Task 4 column catalog", async () => {
    const columns = await sql<{
      column_name: string;
      is_identity: "NO" | "YES";
      is_nullable: "NO" | "YES";
      table_name: string;
      udt_name: string;
    }>`
      select table_name, column_name, udt_name, is_nullable, is_identity
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          'upload_sessions', 'upload_objects', 'assets', 'asset_objects',
          'deliveries', 'receipts', 'inbox_events', 'outbox_events',
          'api_idempotency', 'audit_events', 'clerk_webhook_events'
        )
      order by table_name, ordinal_position
    `.execute(db);

    const catalog = Object.groupBy(
      columns.rows,
      ({ table_name }) => table_name,
    );
    expect(
      Object.fromEntries(
        Object.entries(catalog).map(([tableName, tableColumns]) => [
          tableName,
          tableColumns!.map(
            ({ column_name, is_identity, is_nullable, udt_name }) =>
              `${column_name}:${udt_name}:${is_nullable}:${is_identity}`,
          ),
        ]),
      ),
    ).toEqual({
      api_idempotency: [
        "user_id:uuid:NO:NO",
        "route_key:varchar:NO:NO",
        "idempotency_key:uuid:NO:NO",
        "request_sha256:bytea:NO:NO",
        "response_status:int2:NO:NO",
        "response_body:jsonb:NO:NO",
        "expires_at:timestamptz:NO:NO",
      ],
      asset_objects: [
        "asset_id:uuid:NO:NO",
        "variant:text:NO:NO",
        "s3_key:text:NO:NO",
        "ciphertext_bytes:int8:NO:NO",
        "ciphertext_sha256:bytea:NO:NO",
        "etag:text:NO:NO",
        "created_at:timestamptz:NO:NO",
        "deleted_at:timestamptz:YES:NO",
      ],
      assets: [
        "id:uuid:NO:NO",
        "trip_id:uuid:NO:NO",
        "source_device_id:uuid:NO:NO",
        "source_asset_key:varchar:NO:NO",
        "committed_at:timestamptz:NO:NO",
        "media_type:text:NO:NO",
        "key_epoch:int2:NO:NO",
        "encryption_version:int2:NO:NO",
        "encrypted_manifest:bytea:NO:NO",
        "state:text:NO:NO",
        "purge_pending_at:timestamptz:YES:NO",
        "purged_at:timestamptz:YES:NO",
        "expired_at:timestamptz:YES:NO",
        "captured_at:timestamptz:YES:NO",
      ],
      audit_events: [
        "id:uuid:NO:NO",
        "trip_id:uuid:YES:NO",
        "actor_user_id:uuid:YES:NO",
        "actor_device_id:uuid:YES:NO",
        "event_type:varchar:NO:NO",
        "metadata:jsonb:NO:NO",
        "occurred_at:timestamptz:NO:NO",
      ],
      clerk_webhook_events: [
        "event_id:varchar:NO:NO",
        "event_type:varchar:NO:NO",
        "processed_at:timestamptz:NO:NO",
      ],
      deliveries: [
        "id:uuid:NO:NO",
        "asset_id:uuid:NO:NO",
        "recipient_user_id:uuid:NO:NO",
        "recipient_device_id:uuid:NO:NO",
        "state:text:NO:NO",
        "available_at:timestamptz:NO:NO",
        "saved_at:timestamptz:YES:NO",
        "created_at:timestamptz:NO:NO",
      ],
      inbox_events: [
        "sequence:int8:NO:YES",
        "recipient_device_id:uuid:NO:NO",
        "trip_id:uuid:NO:NO",
        "event_type:varchar:NO:NO",
        "aggregate_id:uuid:NO:NO",
        "available_at:timestamptz:NO:NO",
        "payload:jsonb:NO:NO",
        "created_at:timestamptz:NO:NO",
      ],
      outbox_events: [
        "id:uuid:NO:NO",
        "event_type:varchar:NO:NO",
        "aggregate_id:uuid:NO:NO",
        "dedupe_key:varchar:NO:NO",
        "payload:jsonb:NO:NO",
        "available_at:timestamptz:NO:NO",
        "published_at:timestamptz:YES:NO",
        "attempt_count:int4:NO:NO",
        "last_error:text:YES:NO",
        "created_at:timestamptz:NO:NO",
      ],
      receipts: [
        "id:uuid:NO:NO",
        "delivery_id:uuid:NO:NO",
        "receipt_type:text:NO:NO",
        "client_event_id:uuid:NO:NO",
        "client_observed_at:timestamptz:NO:NO",
        "accepted_at:timestamptz:NO:NO",
      ],
      upload_objects: [
        "upload_session_id:uuid:NO:NO",
        "variant:text:NO:NO",
        "s3_key:text:NO:NO",
        "expected_ciphertext_bytes:int8:NO:NO",
        "expected_ciphertext_sha256:bytea:NO:NO",
        "etag:text:YES:NO",
        "verified_at:timestamptz:YES:NO",
      ],
      upload_sessions: [
        "id:uuid:NO:NO",
        "client_asset_id:uuid:NO:NO",
        "trip_id:uuid:NO:NO",
        "source_device_id:uuid:NO:NO",
        "source_asset_key:varchar:NO:NO",
        "media_type:text:NO:NO",
        "key_epoch:int2:NO:NO",
        "encryption_version:int2:NO:NO",
        "encrypted_manifest:bytea:NO:NO",
        "state:text:NO:NO",
        "expires_at:timestamptz:NO:NO",
        "created_at:timestamptz:NO:NO",
        "captured_at:timestamptz:YES:NO",
      ],
    });
  });

  it("keeps plaintext content and location metadata out of PostgreSQL", async () => {
    const prohibited = await sql<{ column_name: string }>`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          'upload_sessions', 'upload_objects', 'assets', 'asset_objects',
          'deliveries', 'receipts', 'inbox_events', 'outbox_events',
          'api_idempotency', 'audit_events', 'clerk_webhook_events'
        )
        and column_name in (
          'plaintext_sha256', 'filename', 'mime_type', 'exif',
          'width', 'height', 'raw_source_id', 'push_token', 'media_key',
          'content_key', 'latitude', 'longitude', 'location'
        )
      order by column_name
    `.execute(db);

    expect(prohibited.rows).toEqual([]);

    const assetCommitColumn = await sql<{
      column_default: string | null;
      is_nullable: "NO" | "YES";
    }>`
      select column_default, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'assets'
        and column_name = 'committed_at'
    `.execute(db);
    expect(assetCommitColumn.rows).toEqual([
      { column_default: null, is_nullable: "NO" },
    ]);
  });

  it("installs every Task 4 check constraint as validated", async () => {
    const constraints = await sql<{
      conname: string;
      convalidated: boolean;
    }>`
      select constraint_record.conname, constraint_record.convalidated
      from pg_constraint as constraint_record
      where constraint_record.conrelid in (
        'upload_sessions'::regclass, 'upload_objects'::regclass,
        'assets'::regclass, 'asset_objects'::regclass,
        'deliveries'::regclass, 'receipts'::regclass,
        'inbox_events'::regclass, 'outbox_events'::regclass,
        'api_idempotency'::regclass, 'audit_events'::regclass,
        'clerk_webhook_events'::regclass
      )
        and constraint_record.contype = 'c'
      order by constraint_record.conname
    `.execute(db);

    expect(constraints.rows.map(({ conname }) => conname)).toEqual([
      "api_idempotency_request_sha256_check",
      "api_idempotency_response_body_check",
      "api_idempotency_response_status_check",
      "api_idempotency_route_key_check",
      "asset_objects_checksum_check",
      "asset_objects_ciphertext_check",
      "asset_objects_deletion_check",
      "asset_objects_etag_check",
      "asset_objects_s3_key_check",
      "asset_objects_variant_check",
      "assets_key_versions_check",
      "assets_lifecycle_check",
      "assets_lifecycle_order_check",
      "assets_manifest_check",
      "assets_media_type_check",
      "assets_source_asset_key_check",
      "assets_state_check",
      "audit_events_actor_check",
      "audit_events_event_type_check",
      "audit_events_metadata_check",
      "clerk_webhook_events_event_id_check",
      "clerk_webhook_events_event_type_check",
      "deliveries_lifecycle_check",
      "deliveries_lifecycle_order_check",
      "deliveries_state_check",
      "inbox_events_event_type_check",
      "inbox_events_payload_check",
      "outbox_events_attempt_count_check",
      "outbox_events_dedupe_key_check",
      "outbox_events_event_type_check",
      "outbox_events_lifecycle_check",
      "outbox_events_payload_check",
      "receipts_type_check",
      "upload_objects_checksum_check",
      "upload_objects_ciphertext_check",
      "upload_objects_s3_key_check",
      "upload_objects_variant_check",
      "upload_objects_verification_check",
      "upload_sessions_expiry_check",
      "upload_sessions_key_versions_check",
      "upload_sessions_manifest_check",
      "upload_sessions_media_type_check",
      "upload_sessions_source_asset_key_check",
      "upload_sessions_state_check",
    ]);
    expect(constraints.rows.every(({ convalidated }) => convalidated)).toBe(
      true,
    );
  });

  it("declares every Task 4 foreign key with RESTRICT deletion", async () => {
    const constraints = await sql<{
      conname: string;
      delete_action: string;
    }>`
      select constraint_record.conname,
             constraint_record.confdeltype::text as delete_action
      from pg_constraint as constraint_record
      where constraint_record.conrelid in (
        'upload_sessions'::regclass, 'upload_objects'::regclass,
        'assets'::regclass, 'asset_objects'::regclass,
        'deliveries'::regclass, 'receipts'::regclass,
        'inbox_events'::regclass, 'outbox_events'::regclass,
        'api_idempotency'::regclass, 'audit_events'::regclass,
        'clerk_webhook_events'::regclass
      )
        and constraint_record.contype = 'f'
      order by constraint_record.conname
    `.execute(db);

    expect(constraints.rows).toEqual([
      { conname: "api_idempotency_user_id_fk", delete_action: "r" },
      { conname: "asset_objects_asset_id_fk", delete_action: "r" },
      { conname: "assets_source_device_fk", delete_action: "r" },
      { conname: "assets_trip_id_fk", delete_action: "r" },
      {
        conname: "audit_events_actor_user_device_fk",
        delete_action: "r",
      },
      { conname: "audit_events_actor_user_id_fk", delete_action: "r" },
      { conname: "audit_events_trip_id_fk", delete_action: "r" },
      { conname: "deliveries_asset_id_fk", delete_action: "r" },
      {
        conname: "deliveries_recipient_user_device_fk",
        delete_action: "r",
      },
      { conname: "deliveries_recipient_user_id_fk", delete_action: "r" },
      {
        conname: "inbox_events_recipient_device_id_fk",
        delete_action: "r",
      },
      { conname: "inbox_events_trip_id_fk", delete_action: "r" },
      { conname: "receipts_delivery_id_fk", delete_action: "r" },
      {
        conname: "upload_objects_upload_session_id_fk",
        delete_action: "r",
      },
      { conname: "upload_sessions_source_device_fk", delete_action: "r" },
      { conname: "upload_sessions_trip_id_fk", delete_action: "r" },
    ]);
  });

  it("creates the exact Task 4 operational indexes", async () => {
    const indexes = await sql<{ indexdef: string; indexname: string }>`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'upload_sessions_state_expires_idx',
          'assets_trip_committed_id_idx',
          'assets_state_committed_idx',
          'deliveries_device_state_available_idx',
          'deliveries_asset_state_idx',
          'deliveries_recipient_user_device_idx',
          'inbox_events_device_sequence_idx',
          'inbox_events_trip_id_idx',
          'outbox_events_unpublished_available_idx',
          'audit_events_trip_occurred_idx',
          'audit_events_actor_user_device_idx',
          'api_idempotency_expires_at_idx'
        )
      order by indexname
    `.execute(db);

    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "api_idempotency_expires_at_idx",
      "assets_state_committed_idx",
      "assets_trip_committed_id_idx",
      "audit_events_actor_user_device_idx",
      "audit_events_trip_occurred_idx",
      "deliveries_asset_state_idx",
      "deliveries_device_state_available_idx",
      "deliveries_recipient_user_device_idx",
      "inbox_events_device_sequence_idx",
      "inbox_events_trip_id_idx",
      "outbox_events_unpublished_available_idx",
      "upload_sessions_state_expires_idx",
    ]);
    const definitions = Object.fromEntries(
      indexes.rows.map(({ indexdef, indexname }) => [indexname, indexdef]),
    );
    expect(definitions.assets_state_committed_idx).toContain(
      "(state, committed_at)",
    );
    expect(definitions.assets_trip_committed_id_idx).toContain(
      "(trip_id, committed_at, id)",
    );
    expect(definitions.audit_events_actor_user_device_idx).toContain(
      "(actor_user_id, actor_device_id)",
    );
    expect(definitions.audit_events_trip_occurred_idx).toContain(
      "(trip_id, occurred_at)",
    );
    expect(definitions.api_idempotency_expires_at_idx).toContain(
      "(expires_at)",
    );
    expect(definitions.deliveries_asset_state_idx).toContain(
      "(asset_id, state)",
    );
    expect(definitions.deliveries_device_state_available_idx).toContain(
      "(recipient_device_id, state, available_at)",
    );
    expect(definitions.deliveries_recipient_user_device_idx).toContain(
      "(recipient_user_id, recipient_device_id)",
    );
    expect(definitions.inbox_events_device_sequence_idx).toContain(
      "(recipient_device_id, sequence)",
    );
    expect(definitions.inbox_events_trip_id_idx).toContain("(trip_id)");
    expect(definitions.outbox_events_unpublished_available_idx).toContain(
      "(available_at)",
    );
    expect(definitions.outbox_events_unpublished_available_idx).toContain(
      "WHERE (published_at IS NULL)",
    );
    expect(definitions.upload_sessions_state_expires_idx).toContain(
      "(state, expires_at)",
    );
  });

  it("can use the idempotency expiry index for bounded ordered cleanup", async () => {
    await sql`set enable_seqscan = off`.execute(db);
    try {
      const explanation = await sql<{ "QUERY PLAN": string }>`
        explain (costs off)
        select user_id, route_key, idempotency_key
        from api_idempotency
        where expires_at <= now()
        order by expires_at, user_id, route_key, idempotency_key
        limit 100
        for update skip locked
      `.execute(db);
      expect(
        explanation.rows.map((row) => row["QUERY PLAN"]).join("\n"),
      ).toContain("api_idempotency_expires_at_idx");
    } finally {
      await sql`reset enable_seqscan`.execute(db);
    }
  });

  it("enforces upload-session identity, immutable source device, and uniqueness", async () => {
    const parents = await fixture.parents();
    const first = await fixture.uploadSession(parents);

    await expectPostgresError(
      fixture.uploadSession(parents, {
        client_asset_id: first.client_asset_id,
      }),
      {
        code: "23505",
        constraint: "upload_sessions_client_asset_id_unique",
      },
    );
    await expectPostgresError(
      fixture.uploadSession(parents, {
        client_asset_id: fixture.uuid(),
        source_asset_key: first.source_asset_key,
      }),
      { code: "23505", constraint: "upload_sessions_source_unique" },
    );
    await expectPostgresError(
      fixture.uploadSession(parents, {
        source_device_id: fixture.uuid(),
      }),
      { code: "23503", constraint: "upload_sessions_source_device_fk" },
    );
  });

  it("bounds upload-session opaque fields, manifest bytes, state, and expiry", async () => {
    const parents = await fixture.parents();

    await fixture.uploadSession(parents, {
      encrypted_manifest: fixedBytes(7, 65_536),
    });
    await expectPostgresError(
      fixture.uploadSession(parents, { source_asset_key: "raw-library-id" }),
      {
        code: "23514",
        constraint: "upload_sessions_source_asset_key_check",
      },
    );
    await expectPostgresError(
      fixture.uploadSession(parents, { media_type: "VIDEO" }),
      {
        code: "23514",
        constraint: "upload_sessions_media_type_check",
      },
    );
    await expectPostgresError(
      fixture.uploadSession(parents, { key_epoch: 2 }),
      {
        code: "23514",
        constraint: "upload_sessions_key_versions_check",
      },
    );
    await expectPostgresError(
      fixture.uploadSession(parents, { encryption_version: 2 }),
      {
        code: "23514",
        constraint: "upload_sessions_key_versions_check",
      },
    );
    await expectPostgresError(
      fixture.uploadSession(parents, { encrypted_manifest: new Uint8Array() }),
      { code: "23514", constraint: "upload_sessions_manifest_check" },
    );
    await expectPostgresError(
      fixture.uploadSession(parents, {
        encrypted_manifest: fixedBytes(7, 65_537),
      }),
      { code: "23514", constraint: "upload_sessions_manifest_check" },
    );
    await expectPostgresError(
      fixture.uploadSession(parents, { state: "UPLOADING" }),
      { code: "23514", constraint: "upload_sessions_state_check" },
    );
    await expectPostgresError(
      fixture.uploadSession(parents, { expires_at: FIXED_NOW }),
      { code: "23514", constraint: "upload_sessions_expiry_check" },
    );

    for (const state of ["VERIFIED", "COMMITTED", "EXPIRED"] as const) {
      await fixture.uploadSession(parents, { state });
    }
  });

  it("enforces upload-object variants, byte maxima, checksums, and verification pairs", async () => {
    const parents = await fixture.parents();
    const session = await fixture.uploadSession(parents);
    const preview = await fixture.uploadObject(session.id);
    await fixture.uploadObject(session.id, {
      expected_ciphertext_bytes: "52428800",
      variant: "ORIGINAL",
    });

    await expectPostgresError(
      fixture.uploadObject((await fixture.uploadSession(parents)).id, {
        s3_key: preview.s3_key,
      }),
      { code: "23505", constraint: "upload_objects_s3_key_unique" },
    );
    await expectPostgresError(
      fixture.uploadObject((await fixture.uploadSession(parents)).id, {
        variant: "THUMBNAIL",
      }),
      { code: "23514", constraint: "upload_objects_variant_check" },
    );
    await expectPostgresError(
      fixture.uploadObject((await fixture.uploadSession(parents)).id, {
        expected_ciphertext_bytes: "524289",
      }),
      { code: "23514", constraint: "upload_objects_ciphertext_check" },
    );
    await expectPostgresError(
      fixture.uploadObject((await fixture.uploadSession(parents)).id, {
        expected_ciphertext_bytes: "52428801",
        variant: "ORIGINAL",
      }),
      { code: "23514", constraint: "upload_objects_ciphertext_check" },
    );
    await expectPostgresError(
      fixture.uploadObject((await fixture.uploadSession(parents)).id, {
        expected_ciphertext_bytes: "0",
      }),
      { code: "23514", constraint: "upload_objects_ciphertext_check" },
    );
    await expectPostgresError(
      fixture.uploadObject((await fixture.uploadSession(parents)).id, {
        expected_ciphertext_sha256: fixedBytes(1, 31),
      }),
      { code: "23514", constraint: "upload_objects_checksum_check" },
    );
    await expectPostgresError(
      fixture.uploadObject((await fixture.uploadSession(parents)).id, {
        s3_key: "",
      }),
      { code: "23514", constraint: "upload_objects_s3_key_check" },
    );
    await expectPostgresError(
      fixture.uploadObject((await fixture.uploadSession(parents)).id, {
        etag: "etag-without-time",
      }),
      { code: "23514", constraint: "upload_objects_verification_check" },
    );
    await expectPostgresError(
      fixture.uploadObject((await fixture.uploadSession(parents)).id, {
        verified_at: FIXED_NOW,
      }),
      { code: "23514", constraint: "upload_objects_verification_check" },
    );
  });

  it("requires server committed_at and keeps asset identity globally stable", async () => {
    const parents = await fixture.parents();
    const first = await fixture.asset(parents);

    await expectPostgresError(fixture.asset(parents, { id: first.id }), {
      code: "23505",
      constraint: "assets_pkey",
    });
    await expectPostgresError(
      fixture.asset(parents, {
        source_asset_key: first.source_asset_key,
      }),
      { code: "23505", constraint: "assets_source_unique" },
    );
    await expectPostgresError(
      sql`
        insert into assets (
          id, trip_id, source_device_id, source_asset_key, media_type,
          key_epoch, encryption_version, encrypted_manifest, state
        ) values (
          ${fixture.uuid()}, ${parents.tripId}, ${parents.sourceDeviceId},
          ${fixture.sourceAssetKey()}, 'PHOTO', 1, 1, ${fixedBytes(2, 64)},
          'COMMITTED'
        )
      `.execute(db),
      { code: "23502", column: "committed_at" },
    );
    await expectPostgresError(
      fixture.asset(parents, { source_device_id: fixture.uuid() }),
      { code: "23503", constraint: "assets_source_device_fk" },
    );
  });

  it("enforces encrypted asset fields and every lifecycle state", async () => {
    const parents = await fixture.parents();
    const later = new Date(FIXED_NOW.getTime() + ONE_HOUR_MS);

    await fixture.asset(parents, {
      encrypted_manifest: fixedBytes(3, 65_536),
    });
    await fixture.asset(parents, {
      purge_pending_at: FIXED_NOW,
      state: "PURGE_PENDING",
    });
    await fixture.asset(parents, {
      purge_pending_at: FIXED_NOW,
      purged_at: later,
      state: "PURGED",
    });
    await fixture.asset(parents, {
      expired_at: later,
      state: "EXPIRED",
    });

    await expectPostgresError(
      fixture.asset(parents, { source_asset_key: "Photos/IMG_0001.HEIC" }),
      { code: "23514", constraint: "assets_source_asset_key_check" },
    );
    await expectPostgresError(fixture.asset(parents, { media_type: "VIDEO" }), {
      code: "23514",
      constraint: "assets_media_type_check",
    });
    await expectPostgresError(fixture.asset(parents, { key_epoch: 2 }), {
      code: "23514",
      constraint: "assets_key_versions_check",
    });
    await expectPostgresError(
      fixture.asset(parents, { encrypted_manifest: new Uint8Array() }),
      { code: "23514", constraint: "assets_manifest_check" },
    );
    await expectPostgresError(
      fixture.asset(parents, {
        encrypted_manifest: fixedBytes(4, 65_537),
      }),
      { code: "23514", constraint: "assets_manifest_check" },
    );
    await expectPostgresError(fixture.asset(parents, { state: "DELETED" }), {
      code: "23514",
      constraint: "assets_state_check",
    });
    await expectPostgresError(
      fixture.asset(parents, {
        purge_pending_at: later,
        state: "COMMITTED",
      }),
      { code: "23514", constraint: "assets_lifecycle_check" },
    );
    await expectPostgresError(
      fixture.asset(parents, {
        purge_pending_at: later,
        purged_at: FIXED_NOW,
        state: "PURGED",
      }),
      { code: "23514", constraint: "assets_lifecycle_order_check" },
    );
  });

  it("enforces committed-object variants, bytes, integrity, and deletion order", async () => {
    const parents = await fixture.parents();
    const asset = await fixture.asset(parents);
    const preview = await fixture.assetObject(asset.id);
    await fixture.assetObject(asset.id, {
      ciphertext_bytes: "52428800",
      variant: "ORIGINAL",
    });

    await expectPostgresError(
      fixture.assetObject((await fixture.asset(parents)).id, {
        s3_key: preview.s3_key,
      }),
      { code: "23505", constraint: "asset_objects_s3_key_unique" },
    );
    await expectPostgresError(
      fixture.assetObject((await fixture.asset(parents)).id, {
        variant: "THUMBNAIL",
      }),
      { code: "23514", constraint: "asset_objects_variant_check" },
    );
    await expectPostgresError(
      fixture.assetObject((await fixture.asset(parents)).id, {
        ciphertext_bytes: "524289",
      }),
      { code: "23514", constraint: "asset_objects_ciphertext_check" },
    );
    await expectPostgresError(
      fixture.assetObject((await fixture.asset(parents)).id, {
        ciphertext_bytes: "52428801",
        variant: "ORIGINAL",
      }),
      { code: "23514", constraint: "asset_objects_ciphertext_check" },
    );
    await expectPostgresError(
      fixture.assetObject((await fixture.asset(parents)).id, {
        ciphertext_sha256: fixedBytes(1, 31),
      }),
      { code: "23514", constraint: "asset_objects_checksum_check" },
    );
    await expectPostgresError(
      fixture.assetObject((await fixture.asset(parents)).id, { s3_key: " " }),
      { code: "23514", constraint: "asset_objects_s3_key_check" },
    );
    await expectPostgresError(
      fixture.assetObject((await fixture.asset(parents)).id, { etag: " " }),
      { code: "23514", constraint: "asset_objects_etag_check" },
    );
    await expectPostgresError(
      fixture.assetObject((await fixture.asset(parents)).id, {
        deleted_at: new Date(FIXED_NOW.getTime() - 1),
      }),
      { code: "23514", constraint: "asset_objects_deletion_check" },
    );
  });

  it("keeps one delivery per asset/device and binds the recipient device to its user", async () => {
    const parents = await fixture.parents();
    const asset = await fixture.asset(parents);
    await fixture.delivery(asset.id, parents);

    await expectPostgresError(fixture.delivery(asset.id, parents), {
      code: "23505",
      constraint: "deliveries_asset_device_unique",
    });
    await expectPostgresError(
      fixture.delivery((await fixture.asset(parents)).id, parents, {
        recipient_user_id: parents.sourceUserId,
      }),
      {
        code: "23503",
        constraint: "deliveries_recipient_user_device_fk",
      },
    );
    await expectPostgresError(fixture.delivery(fixture.uuid(), parents), {
      code: "23503",
      constraint: "deliveries_asset_id_fk",
    });
  });

  it("enforces every delivery state and lifecycle timestamp", async () => {
    const parents = await fixture.parents();
    const later = new Date(FIXED_NOW.getTime() + ONE_HOUR_MS);

    await fixture.delivery((await fixture.asset(parents)).id, parents, {
      available_at: later,
      state: "HELD",
    });
    await fixture.delivery((await fixture.asset(parents)).id, parents);
    await fixture.delivery((await fixture.asset(parents)).id, parents, {
      saved_at: later,
      state: "SAVED_LOCALLY",
    });
    await fixture.delivery((await fixture.asset(parents)).id, parents, {
      state: "EXPIRED",
    });

    await expectPostgresError(
      fixture.delivery((await fixture.asset(parents)).id, parents, {
        state: "DOWNLOADING",
      }),
      { code: "23514", constraint: "deliveries_state_check" },
    );
    await expectPostgresError(
      fixture.delivery((await fixture.asset(parents)).id, parents, {
        state: "SAVED_LOCALLY",
      }),
      { code: "23514", constraint: "deliveries_lifecycle_check" },
    );
    await expectPostgresError(
      fixture.delivery((await fixture.asset(parents)).id, parents, {
        saved_at: later,
        state: "READY",
      }),
      { code: "23514", constraint: "deliveries_lifecycle_check" },
    );
    await expectPostgresError(
      fixture.delivery((await fixture.asset(parents)).id, parents, {
        available_at: later,
        saved_at: FIXED_NOW,
        state: "SAVED_LOCALLY",
      }),
      { code: "23514", constraint: "deliveries_lifecycle_order_check" },
    );
  });

  it("deduplicates receipts by client event and semantic delivery type", async () => {
    const parents = await fixture.parents();
    const firstDelivery = await fixture.delivery(
      (await fixture.asset(parents)).id,
      parents,
      { saved_at: FIXED_NOW, state: "SAVED_LOCALLY" },
    );
    const savedReceipt = await fixture.receipt(firstDelivery.id);
    await fixture.receipt(firstDelivery.id, { receipt_type: "SOURCE_PRESENT" });

    await expectPostgresError(fixture.receipt(firstDelivery.id), {
      code: "23505",
      constraint: "receipts_delivery_type_unique",
    });

    const secondDelivery = await fixture.delivery(
      (await fixture.asset(parents)).id,
      parents,
      { saved_at: FIXED_NOW, state: "SAVED_LOCALLY" },
    );
    await expectPostgresError(
      fixture.receipt(secondDelivery.id, {
        client_event_id: savedReceipt.client_event_id,
      }),
      { code: "23505", constraint: "receipts_client_event_id_unique" },
    );
    await expectPostgresError(
      fixture.receipt(secondDelivery.id, { receipt_type: "DOWNLOADED" }),
      { code: "23514", constraint: "receipts_type_check" },
    );
    await expectPostgresError(fixture.receipt(fixture.uuid()), {
      code: "23503",
      constraint: "receipts_delivery_id_fk",
    });
  });

  it("assigns monotonic inbox sequences and rejects non-object or oversized payloads", async () => {
    const parents = await fixture.parents();
    const first = BigInt(await fixture.inboxEvent(parents));
    const second = BigInt(await fixture.inboxEvent(parents));

    expect(second).toBeGreaterThan(first);
    await expectPostgresError(
      fixture.inboxEvent(parents, { event_type: " " }),
      { code: "23514", constraint: "inbox_events_event_type_check" },
    );
    await expectPostgresError(fixture.inboxEvent(parents, { payload: [] }), {
      code: "23514",
      constraint: "inbox_events_payload_check",
    });
    await expectPostgresError(
      fixture.inboxEvent(parents, {
        payload: { value: "x".repeat(65_536) },
      }),
      { code: "23514", constraint: "inbox_events_payload_check" },
    );
    await expectPostgresError(
      fixture.inboxEvent(parents, {
        recipient_device_id: fixture.uuid(),
      }),
      {
        code: "23503",
        constraint: "inbox_events_recipient_device_id_fk",
      },
    );
    await expectPostgresError(
      fixture.inboxEvent(parents, { trip_id: fixture.uuid() }),
      { code: "23503", constraint: "inbox_events_trip_id_fk" },
    );
  });

  it("deduplicates bounded outbox work and keeps publication lifecycle coherent", async () => {
    const first = await fixture.outboxEvent();
    await fixture.outboxEvent({
      attempt_count: 2,
      last_error: "OBJECT_NOT_READY",
      published_at: new Date(FIXED_NOW.getTime() + ONE_HOUR_MS),
    });

    await expectPostgresError(
      fixture.outboxEvent({ dedupe_key: first.dedupe_key }),
      { code: "23505", constraint: "outbox_events_dedupe_key_unique" },
    );
    await expectPostgresError(fixture.outboxEvent({ event_type: "" }), {
      code: "23514",
      constraint: "outbox_events_event_type_check",
    });
    await expectPostgresError(fixture.outboxEvent({ dedupe_key: " " }), {
      code: "23514",
      constraint: "outbox_events_dedupe_key_check",
    });
    await expectPostgresError(fixture.outboxEvent({ payload: [] }), {
      code: "23514",
      constraint: "outbox_events_payload_check",
    });
    await expectPostgresError(
      fixture.outboxEvent({ payload: { value: "x".repeat(65_536) } }),
      { code: "23514", constraint: "outbox_events_payload_check" },
    );
    await expectPostgresError(fixture.outboxEvent({ attempt_count: -1 }), {
      code: "23514",
      constraint: "outbox_events_attempt_count_check",
    });
    await expectPostgresError(
      fixture.outboxEvent({
        published_at: new Date(FIXED_NOW.getTime() - 1),
      }),
      { code: "23514", constraint: "outbox_events_lifecycle_check" },
    );
    await expectPostgresError(fixture.outboxEvent({ last_error: " " }), {
      code: "23514",
      constraint: "outbox_events_lifecycle_check",
    });
  });

  it("binds idempotency to actor, route, key, request hash, and response", async () => {
    const parents = await fixture.parents();
    const first = await fixture.apiIdempotency(parents.sourceUserId);

    await expectPostgresError(
      fixture.apiIdempotency(parents.sourceUserId, {
        idempotency_key: first.idempotency_key,
        route_key: first.route_key,
      }),
      { code: "23505", constraint: "api_idempotency_pk" },
    );
    await expectPostgresError(
      fixture.apiIdempotency(parents.sourceUserId, { route_key: " " }),
      { code: "23514", constraint: "api_idempotency_route_key_check" },
    );
    await expectPostgresError(
      fixture.apiIdempotency(parents.sourceUserId, {
        request_sha256: fixedBytes(2, 31),
      }),
      {
        code: "23514",
        constraint: "api_idempotency_request_sha256_check",
      },
    );
    await expectPostgresError(
      fixture.apiIdempotency(parents.sourceUserId, { response_status: 99 }),
      {
        code: "23514",
        constraint: "api_idempotency_response_status_check",
      },
    );
    await expectPostgresError(
      fixture.apiIdempotency(parents.sourceUserId, { response_status: 600 }),
      {
        code: "23514",
        constraint: "api_idempotency_response_status_check",
      },
    );
    await expectPostgresError(
      fixture.apiIdempotency(parents.sourceUserId, { response_body: [] }),
      {
        code: "23514",
        constraint: "api_idempotency_response_body_check",
      },
    );
    await expectPostgresError(fixture.apiIdempotency(fixture.uuid()), {
      code: "23503",
      constraint: "api_idempotency_user_id_fk",
    });
  });

  it("keeps audit metadata bounded and actor/device relationships authentic", async () => {
    const parents = await fixture.parents();
    await fixture.auditEvent(parents, {
      actor_device_id: null,
      actor_user_id: null,
      trip_id: null,
    });

    await expectPostgresError(
      fixture.auditEvent(parents, { event_type: " " }),
      { code: "23514", constraint: "audit_events_event_type_check" },
    );
    await expectPostgresError(fixture.auditEvent(parents, { metadata: [] }), {
      code: "23514",
      constraint: "audit_events_metadata_check",
    });
    await expectPostgresError(
      fixture.auditEvent(parents, {
        metadata: { value: "x".repeat(65_536) },
      }),
      { code: "23514", constraint: "audit_events_metadata_check" },
    );
    await expectPostgresError(
      fixture.auditEvent(parents, { actor_user_id: null }),
      { code: "23514", constraint: "audit_events_actor_check" },
    );
    await expectPostgresError(
      fixture.auditEvent(parents, {
        actor_user_id: parents.outsiderUserId,
      }),
      {
        code: "23503",
        constraint: "audit_events_actor_user_device_fk",
      },
    );
    await expectPostgresError(
      fixture.auditEvent(parents, { trip_id: fixture.uuid() }),
      { code: "23503", constraint: "audit_events_trip_id_fk" },
    );
  });

  it("deduplicates Clerk webhooks and bounds their opaque identifiers", async () => {
    const first = await fixture.clerkWebhookEvent();

    await expectPostgresError(
      fixture.clerkWebhookEvent({ event_id: first.event_id }),
      { code: "23505", constraint: "clerk_webhook_events_pkey" },
    );
    await expectPostgresError(fixture.clerkWebhookEvent({ event_id: " " }), {
      code: "23514",
      constraint: "clerk_webhook_events_event_id_check",
    });
    await expectPostgresError(fixture.clerkWebhookEvent({ event_type: " " }), {
      code: "23514",
      constraint: "clerk_webhook_events_event_type_check",
    });
  });

  it("upgrades an exact 001 prior-version database without losing identity rows", async () => {
    const prior = await startMigratedPostgres();

    try {
      await migrateDown(prior.db); // 009
      await migrateDown(prior.db); // 008
      await migrateDown(prior.db); // 007
      await migrateDown(prior.db); // 006
      await migrateDown(prior.db); // one migration

      await migrateDown(prior.db);
      await migrateDown(prior.db);
      await migrateDown(prior.db);
      const priorFixture = createMediaCoordinationFixtures(prior.db);
      const user = await priorFixture.identity.user();
      const trip = await priorFixture.identity.trip(user.id);
      const task4Before = await sql<{ table_name: string }>`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in ('upload_sessions', 'inbox_events')
      `.execute(prior.db);
      expect(task4Before.rows).toEqual([]);

      await migrateToLatest(prior.db);

      const preserved = await sql<{ trip_id: string; user_id: string }>`
        select trips.id as trip_id, users.id as user_id
        from trips
        join users on users.id = trips.owner_user_id
        where trips.id = ${trip.id} and users.id = ${user.id}
      `.execute(prior.db);
      expect(preserved.rows).toEqual([{ trip_id: trip.id, user_id: user.id }]);

      const task4After = await sql<{ table_name: string }>`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in ('upload_sessions', 'inbox_events')
        order by table_name
      `.execute(prior.db);
      expect(task4After.rows.map(({ table_name }) => table_name)).toEqual([
        "inbox_events",
        "upload_sessions",
      ]);
    } finally {
      await prior.stop();
    }
  });

  it("migrates an empty database up, fully down, and up again", async () => {
    await migrateDown(db); // 009
    await migrateDown(db); // 008
    await migrateDown(db); // 007
    await migrateDown(db); // 006
    await migrateDown(db); // 005

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
      order by table_name
    `.execute(db);
    const indexesAfterDown = await sql<{ indexname: string }>`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'devices_user_active_idx', 'trip_members_trip_state_idx',
          'trips_state_ends_idx', 'upload_sessions_state_expires_idx',
          'assets_trip_committed_id_idx', 'assets_state_committed_idx',
          'deliveries_device_state_available_idx',
          'deliveries_asset_state_idx',
          'deliveries_recipient_user_device_idx',
          'inbox_events_device_sequence_idx', 'inbox_events_trip_id_idx',
          'outbox_events_unpublished_available_idx',
          'audit_events_trip_occurred_idx',
          'audit_events_actor_user_device_idx',
          'api_idempotency_expires_at_idx'
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
      order by table_name
    `.execute(db);
    expect(
      tablesAfterSecondUp.rows.map(({ table_name }) => table_name),
    ).toEqual([
      "api_idempotency",
      "asset_objects",
      "assets",
      "audit_events",
      "clerk_webhook_events",
      "deliveries",
      "devices",
      "inbox_events",
      "media_cleanup_claims",
      "outbox_events",
      "receipts",
      "trip_device_requests",
      "trip_invites",
      "trip_key_envelopes",
      "trip_members",
      "trip_owner_invites",
      "trips",
      "upload_objects",
      "upload_sessions",
      "user_active_trips",
      "users",
    ]);
    const indexesAfterSecondUp = await sql<{ indexname: string }>`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname = 'api_idempotency_expires_at_idx'
    `.execute(db);
    expect(indexesAfterSecondUp.rows).toEqual([
      { indexname: "api_idempotency_expires_at_idx" },
    ]);
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
    const restoredAuthenticationChecks = await sql<{ definition: string }>`
      select pg_get_constraintdef(constraint_record.oid) as definition
      from pg_constraint as constraint_record
      where constraint_record.conname = 'devices_authentication_key_check'
        and constraint_record.conrelid = 'devices'::regclass
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
    expect(restoredAuthenticationChecks.rows).toHaveLength(1);
    expect(restoredAuthenticationChecks.rows[0]!.definition).toContain(
      "octet_length(authentication_public_key) = 65",
    );
  });
});
