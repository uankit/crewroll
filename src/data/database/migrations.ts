import type { SQLiteDatabase } from 'expo-sqlite';

import {
  DatabaseInitializationError,
  UnsupportedDatabaseVersionError,
} from './errors';

interface UserVersionRow {
  user_version: number;
}

interface ForeignKeyViolationRow {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

interface TableInfoRow {
  name: string;
}

interface Migration {
  readonly version: number;
  readonly name: string;
  up(database: SQLiteDatabase): Promise<void>;
}

const createInitialSchema: Migration = {
  version: 1,
  name: 'create_local_first_schema',
  async up(database) {
    // This string is static migration SQL. Runtime/user values are always bound
    // through runAsync in repositories.
    await database.execAsync(`
      CREATE TABLE trips (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        name TEXT NOT NULL CHECK (length(name) > 0),
        created_by_member_id TEXT NOT NULL CHECK (length(created_by_member_id) > 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        starts_at_ms INTEGER NOT NULL CHECK (starts_at_ms >= 0),
        ends_at_ms INTEGER CHECK (ends_at_ms IS NULL OR ends_at_ms >= starts_at_ms),
        time_zone TEXT NOT NULL CHECK (length(time_zone) > 0),
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED', 'ARCHIVED')),
        default_sharing_mode TEXT NOT NULL CHECK (default_sharing_mode IN ('REVIEW_FIRST', 'AUTO_SHARE', 'MANUAL')),
        location_sharing_mode TEXT NOT NULL CHECK (location_sharing_mode IN ('NONE', 'APPROXIMATE', 'EXACT')),
        target_replica_count INTEGER NOT NULL CHECK (target_replica_count BETWEEN 1 AND 3),
        complete_keeper_count INTEGER NOT NULL CHECK (
          complete_keeper_count BETWEEN 0 AND 2
          AND complete_keeper_count <= target_replica_count
        ),
        membership_epoch INTEGER NOT NULL CHECK (membership_epoch >= 0),
        is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1))
      );

      CREATE UNIQUE INDEX trips_one_active_unique
        ON trips(is_active) WHERE is_active = 1;
      CREATE INDEX trips_created_at_index
        ON trips(created_at_ms DESC, id ASC);

      CREATE TABLE members (
        trip_id TEXT NOT NULL,
        id TEXT NOT NULL CHECK (length(id) > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        device_id TEXT NOT NULL CHECK (length(device_id) > 0),
        display_name TEXT NOT NULL CHECK (length(display_name) > 0),
        identity_public_key TEXT NOT NULL CHECK (length(identity_public_key) > 0),
        role TEXT NOT NULL CHECK (role IN ('ADMIN', 'MEMBER')),
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'LEAVING', 'LEFT', 'REMOVED')),
        replica_role TEXT NOT NULL CHECK (replica_role IN ('NONE', 'KEEPER_PRIMARY', 'KEEPER_SECONDARY', 'WITNESS')),
        joined_at_ms INTEGER NOT NULL CHECK (joined_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        left_at_ms INTEGER CHECK (left_at_ms IS NULL OR left_at_ms >= joined_at_ms),
        membership_epoch INTEGER NOT NULL CHECK (membership_epoch >= 0),
        PRIMARY KEY (trip_id, id),
        FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX members_one_active_device_unique
        ON members(trip_id, device_id)
        WHERE status IN ('ACTIVE', 'LEAVING');
      CREATE INDEX members_status_index
        ON members(trip_id, status, joined_at_ms ASC, id ASC);

      CREATE TABLE media (
        trip_id TEXT NOT NULL,
        id TEXT NOT NULL CHECK (length(id) > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        origin_member_id TEXT NOT NULL,
        origin_device_id TEXT NOT NULL CHECK (length(origin_device_id) > 0),
        origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),
        source_asset_id TEXT,
        source TEXT NOT NULL CHECK (source = 'SYSTEM_LIBRARY'),
        media_type TEXT NOT NULL CHECK (media_type = 'IMAGE'),
        share_status TEXT NOT NULL CHECK (share_status IN ('PRIVATE', 'QUEUED', 'PUBLISHED', 'TOMBSTONED')),
        captured_at_ms INTEGER NOT NULL CHECK (captured_at_ms >= 0),
        capture_timezone_offset_minutes INTEGER NOT NULL,
        capture_local_date TEXT NOT NULL CHECK (length(capture_local_date) > 0),
        ingested_at_ms INTEGER NOT NULL CHECK (ingested_at_ms >= 0),
        published_at_ms INTEGER CHECK (published_at_ms IS NULL OR published_at_ms >= 0),
        tombstoned_at_ms INTEGER CHECK (tombstoned_at_ms IS NULL OR tombstoned_at_ms >= 0),
        location_json TEXT,
        original_resource_id TEXT NOT NULL CHECK (length(original_resource_id) > 0),
        thumbnail_resource_id TEXT,
        PRIMARY KEY (trip_id, id),
        UNIQUE (trip_id, origin_device_id, origin_sequence),
        FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
        FOREIGN KEY (trip_id, origin_member_id)
          REFERENCES members(trip_id, id) ON DELETE RESTRICT
      );

      CREATE INDEX media_timeline_index
        ON media(trip_id, captured_at_ms DESC, id ASC);
      CREATE INDEX media_creator_index
        ON media(trip_id, origin_member_id, captured_at_ms DESC, id ASC);
      CREATE UNIQUE INDEX media_local_source_asset_unique
        ON media(trip_id, origin_device_id, source_asset_id)
        WHERE source_asset_id IS NOT NULL;

      CREATE TABLE resources (
        trip_id TEXT NOT NULL,
        id TEXT NOT NULL CHECK (length(id) > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        media_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ORIGINAL', 'THUMBNAIL')),
        mime_type TEXT NOT NULL CHECK (length(mime_type) > 0),
        file_extension TEXT NOT NULL CHECK (length(file_extension) > 0),
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) > 0),
        width INTEGER NOT NULL CHECK (width > 0),
        height INTEGER NOT NULL CHECK (height > 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        availability TEXT NOT NULL CHECK (availability IN ('missing', 'partial', 'available')),
        local_uri TEXT,
        verified_at_ms INTEGER CHECK (verified_at_ms IS NULL OR verified_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        PRIMARY KEY (trip_id, id),
        UNIQUE (trip_id, media_id, kind),
        FOREIGN KEY (trip_id, media_id)
          REFERENCES media(trip_id, id) ON DELETE CASCADE,
        CHECK (
          availability <> 'available'
          OR (local_uri IS NOT NULL AND verified_at_ms IS NOT NULL)
        )
      );

      CREATE INDEX resources_availability_index
        ON resources(trip_id, availability, kind, id ASC);
      CREATE INDEX resources_hash_index
        ON resources(sha256, byte_length);

      CREATE TABLE replica_receipts (
        trip_id TEXT NOT NULL,
        id TEXT NOT NULL CHECK (length(id) > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        media_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        holder_member_id TEXT NOT NULL,
        holder_device_id TEXT NOT NULL CHECK (length(holder_device_id) > 0),
        resource_sha256 TEXT NOT NULL CHECK (length(resource_sha256) > 0),
        resource_byte_length INTEGER NOT NULL CHECK (resource_byte_length >= 0),
        status TEXT NOT NULL CHECK (status IN ('VERIFIED', 'RELEASED', 'LOST')),
        verified_at_ms INTEGER NOT NULL CHECK (verified_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= verified_at_ms),
        PRIMARY KEY (trip_id, id),
        UNIQUE (trip_id, resource_id, holder_device_id),
        FOREIGN KEY (trip_id, media_id)
          REFERENCES media(trip_id, id) ON DELETE CASCADE,
        FOREIGN KEY (trip_id, resource_id)
          REFERENCES resources(trip_id, id) ON DELETE CASCADE,
        FOREIGN KEY (trip_id, holder_member_id)
          REFERENCES members(trip_id, id) ON DELETE CASCADE
      );

      CREATE INDEX replica_receipts_member_index
        ON replica_receipts(trip_id, holder_member_id, status, updated_at_ms DESC, resource_id ASC);

      CREATE TABLE sync_operations (
        trip_id TEXT NOT NULL,
        operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        origin_device_id TEXT NOT NULL CHECK (length(origin_device_id) > 0),
        origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),
        actor_member_id TEXT NOT NULL,
        membership_epoch INTEGER NOT NULL CHECK (membership_epoch >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('TRIP_CREATED', 'TRIP_STATUS_CHANGED', 'MEMBER_JOINED', 'MEMBER_STATUS_CHANGED', 'MEDIA_PUBLISHED', 'MEDIA_TOMBSTONED', 'REPLICA_RECORDED', 'REPLICA_STATUS_CHANGED')),
        payload_json TEXT NOT NULL,
        PRIMARY KEY (trip_id, operation_id),
        UNIQUE (trip_id, origin_device_id, origin_sequence),
        FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
      );

      CREATE INDEX sync_operations_log_index
        ON sync_operations(trip_id, origin_device_id, origin_sequence ASC, operation_id ASC);
      CREATE INDEX sync_operations_created_index
        ON sync_operations(trip_id, created_at_ms ASC, operation_id ASC);

      CREATE TABLE outbox (
        trip_id TEXT NOT NULL,
        id TEXT NOT NULL CHECK (length(id) > 0),
        recipient_member_id TEXT,
        message_type TEXT NOT NULL CHECK (
          length(message_type) > 0 AND message_type <> 'RESOURCE_CHUNK'
        ),
        payload_json TEXT NOT NULL,
        dedupe_key TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'in_flight', 'delivered', 'dead_letter')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at INTEGER NOT NULL CHECK (available_at >= 0),
        lease_owner TEXT,
        lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
        last_error TEXT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        PRIMARY KEY (trip_id, id),
        UNIQUE (trip_id, dedupe_key),
        FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
        FOREIGN KEY (trip_id, recipient_member_id)
          REFERENCES members(trip_id, id) ON DELETE CASCADE
      );

      CREATE INDEX outbox_delivery_index
        ON outbox(trip_id, state, available_at ASC, created_at ASC, id ASC);
      CREATE INDEX outbox_lease_index
        ON outbox(state, lease_expires_at ASC);

      CREATE TABLE transfers (
        trip_id TEXT NOT NULL,
        id TEXT NOT NULL CHECK (length(id) > 0),
        resource_id TEXT NOT NULL,
        peer_member_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
        state TEXT NOT NULL CHECK (state IN ('queued', 'transferring', 'verifying', 'paused', 'completed', 'failed', 'cancelled')),
        bytes_transferred INTEGER NOT NULL DEFAULT 0 CHECK (bytes_transferred >= 0),
        total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
        chunk_size INTEGER NOT NULL CHECK (chunk_size > 0),
        next_chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk_index >= 0),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error TEXT,
        started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
        completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        PRIMARY KEY (trip_id, id),
        FOREIGN KEY (trip_id, resource_id)
          REFERENCES resources(trip_id, id) ON DELETE CASCADE,
        FOREIGN KEY (trip_id, peer_member_id)
          REFERENCES members(trip_id, id) ON DELETE CASCADE,
        CHECK (bytes_transferred <= total_bytes),
        CHECK (state <> 'completed' OR bytes_transferred = total_bytes)
      );

      CREATE INDEX transfers_active_index
        ON transfers(trip_id, state, updated_at ASC, id ASC);
      CREATE INDEX transfers_resource_index
        ON transfers(trip_id, resource_id, peer_member_id, direction, id ASC);

      CREATE TABLE device_settings (
        key TEXT PRIMARY KEY NOT NULL CHECK (length(key) > 0),
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
      );
    `);
  },
};

const removeRetiredJoinCode: Migration = {
  version: 2,
  name: 'remove_retired_join_code',
  async up(database) {
    const columns = await database.getAllAsync<TableInfoRow>('PRAGMA table_info(trips)');
    if (!columns.some((column) => column.name === 'join_code')) return;

    await database.execAsync(`
      DROP INDEX IF EXISTS trips_live_join_code_unique;
      DROP INDEX IF EXISTS trips_join_code_index;
      ALTER TABLE trips DROP COLUMN join_code;
    `);
  },
};

interface SchemaSqlRow {
  sql: string | null;
}

const addTransferVerifyingState: Migration = {
  version: 3,
  name: 'add_transfer_verifying_state',
  async up(database) {
    const schema = await database.getFirstAsync<SchemaSqlRow>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transfers'`,
    );
    if (schema?.sql?.includes("'verifying'")) return;

    // SQLite cannot widen a CHECK constraint in place. No table references
    // transfers, so rebuilding it preserves all rows and foreign-key meaning.
    await database.execAsync(`
      CREATE TABLE transfers_v3 (
        trip_id TEXT NOT NULL,
        id TEXT NOT NULL CHECK (length(id) > 0),
        resource_id TEXT NOT NULL,
        peer_member_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
        state TEXT NOT NULL CHECK (state IN ('queued', 'transferring', 'verifying', 'paused', 'completed', 'failed', 'cancelled')),
        bytes_transferred INTEGER NOT NULL DEFAULT 0 CHECK (bytes_transferred >= 0),
        total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
        chunk_size INTEGER NOT NULL CHECK (chunk_size > 0),
        next_chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk_index >= 0),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error TEXT,
        started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
        completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        PRIMARY KEY (trip_id, id),
        FOREIGN KEY (trip_id, resource_id)
          REFERENCES resources(trip_id, id) ON DELETE CASCADE,
        FOREIGN KEY (trip_id, peer_member_id)
          REFERENCES members(trip_id, id) ON DELETE CASCADE,
        CHECK (bytes_transferred <= total_bytes),
        CHECK (state <> 'completed' OR bytes_transferred = total_bytes)
      );

      INSERT INTO transfers_v3 (
        trip_id, id, resource_id, peer_member_id, direction, state,
        bytes_transferred, total_bytes, chunk_size, next_chunk_index,
        attempt_count, last_error, started_at, completed_at, created_at, updated_at
      )
      SELECT
        trip_id, id, resource_id, peer_member_id, direction, state,
        bytes_transferred, total_bytes, chunk_size, next_chunk_index,
        attempt_count, last_error, started_at, completed_at, created_at, updated_at
      FROM transfers;

      DROP TABLE transfers;
      ALTER TABLE transfers_v3 RENAME TO transfers;
      CREATE INDEX transfers_active_index
        ON transfers(trip_id, state, updated_at ASC, id ASC);
      CREATE INDEX transfers_resource_index
        ON transfers(trip_id, resource_id, peer_member_id, direction, id ASC);
    `);
  },
};

const addPhasedMediaPublicationOperations: Migration = {
  version: 4,
  name: 'add_phased_media_publication_operations',
  async up(database) {
    const schema = await database.getFirstAsync<SchemaSqlRow>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sync_operations'`,
    );
    if (
      schema?.sql?.includes("'MEDIA_PREVIEW_PUBLISHED'") &&
      schema.sql.includes("'MEDIA_ORIGINAL_PUBLISHED'")
    ) return;

    await database.execAsync(`
      CREATE TABLE sync_operations_v4 (
        trip_id TEXT NOT NULL,
        operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        origin_device_id TEXT NOT NULL CHECK (length(origin_device_id) > 0),
        origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),
        actor_member_id TEXT NOT NULL,
        membership_epoch INTEGER NOT NULL CHECK (membership_epoch >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        kind TEXT NOT NULL CHECK (kind IN (
          'TRIP_CREATED', 'TRIP_STATUS_CHANGED', 'MEMBER_JOINED', 'MEMBER_STATUS_CHANGED',
          'MEDIA_PREVIEW_PUBLISHED', 'MEDIA_ORIGINAL_PUBLISHED', 'MEDIA_PUBLISHED',
          'MEDIA_TOMBSTONED', 'REPLICA_RECORDED', 'REPLICA_STATUS_CHANGED'
        )),
        payload_json TEXT NOT NULL,
        PRIMARY KEY (trip_id, operation_id),
        UNIQUE (trip_id, origin_device_id, origin_sequence),
        FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
      );

      INSERT INTO sync_operations_v4 (
        trip_id, operation_id, schema_version, origin_device_id, origin_sequence,
        actor_member_id, membership_epoch, created_at_ms, kind, payload_json
      )
      SELECT
        trip_id, operation_id, schema_version, origin_device_id, origin_sequence,
        actor_member_id, membership_epoch, created_at_ms, kind, payload_json
      FROM sync_operations;

      DROP TABLE sync_operations;
      ALTER TABLE sync_operations_v4 RENAME TO sync_operations;
      CREATE INDEX sync_operations_log_index
        ON sync_operations(trip_id, origin_device_id, origin_sequence ASC, operation_id ASC);
      CREATE INDEX sync_operations_created_index
        ON sync_operations(trip_id, created_at_ms ASC, operation_id ASC);
    `);
  },
};

const addTransferAndRetentionIndexes: Migration = {
  version: 5,
  name: 'add_transfer_queue_and_retention_indexes',
  async up(database) {
    // listRecent orders in the opposite direction to the active-work index,
    // and the state column in that index prevents SQLite from using it for a
    // trip-wide history read. Keep the mixed sort directions exact so a
    // bounded diagnostics/history read does not build a temporary sort.
    //
    // Partial indexes keep active transfer/outbox writes out of retention
    // structures. Cleanup remains explicit (and therefore policy-controlled
    // by the application), but it must not scan an ever-growing journal.
    // The unavailable-resource expression exactly matches reconciliation's
    // thumbnail-first order, avoiding a temp sort on every recovery pass.
    await database.execAsync(`
      CREATE INDEX IF NOT EXISTS transfers_recent_index
        ON transfers(trip_id, updated_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS transfers_retention_index
        ON transfers(updated_at ASC)
        WHERE state IN ('completed', 'failed', 'cancelled');
      CREATE INDEX IF NOT EXISTS outbox_retention_index
        ON outbox(updated_at ASC)
        WHERE state = 'delivered';
      CREATE INDEX IF NOT EXISTS outbox_dead_letter_retention_index
        ON outbox(updated_at ASC)
        WHERE state = 'dead_letter';
      CREATE INDEX IF NOT EXISTS outbox_in_flight_wake_index
        ON outbox(trip_id, lease_expires_at ASC)
        WHERE state = 'in_flight';
      CREATE INDEX IF NOT EXISTS resources_unavailable_queue_index
        ON resources(
          trip_id,
          CASE kind WHEN 'THUMBNAIL' THEN 0 ELSE 1 END,
          created_at_ms ASC,
          id ASC
        )
        WHERE availability <> 'available';
    `);
  },
};

const migrations: readonly Migration[] = [
  createInitialSchema,
  removeRetiredJoinCode,
  addTransferVerifyingState,
  addPhasedMediaPublicationOperations,
  addTransferAndRetentionIndexes,
];

export const DATABASE_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;

export async function migrateDatabase(database: SQLiteDatabase): Promise<void> {
  const versionRow = await database.getFirstAsync<UserVersionRow>('PRAGMA user_version');
  if (!versionRow || !Number.isSafeInteger(versionRow.user_version)) {
    throw new DatabaseInitializationError('SQLite did not return a valid PRAGMA user_version.');
  }

  if (versionRow.user_version > DATABASE_SCHEMA_VERSION) {
    throw new UnsupportedDatabaseVersionError(
      versionRow.user_version,
      DATABASE_SCHEMA_VERSION,
    );
  }

  let currentVersion = versionRow.user_version;
  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    if (migration.version !== currentVersion + 1) {
      throw new DatabaseInitializationError(
        `Migration '${migration.name}' is version ${migration.version}; expected ${currentVersion + 1}.`,
      );
    }

    await database.withTransactionAsync(async () => {
      await migration.up(database);
      // Migration versions are static trusted integers, not runtime input.
      await database.execAsync(`PRAGMA user_version = ${migration.version}`);
    });
    currentVersion = migration.version;
  }

  const violations = await database.getAllAsync<ForeignKeyViolationRow>('PRAGMA foreign_key_check');
  if (violations.length > 0) {
    const first = violations[0];
    throw new DatabaseInitializationError(
      `Foreign-key check failed for ${first.table} row ${String(first.rowid)} -> ${first.parent}.`,
    );
  }
}
