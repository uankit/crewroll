import type { SQLiteDatabase } from 'expo-sqlite';

import {
  databaseClient,
  type AirMeshDatabaseClient,
} from '../database/client';
import { RecordNotFoundError } from '../database/errors';
import type {
  LocationSharingMode,
  SharingMode,
  TripRecord,
  TripStatus,
} from '../types';
import type { TripRepository } from './contracts';
import {
  enumValue,
  nullableNumber,
  requiredNumber,
  requiredString,
  sqliteBoolean,
} from './rowMapping';

const TRIP_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED', 'ARCHIVED'] as const;
const SHARING_MODES = ['REVIEW_FIRST', 'AUTO_SHARE', 'MANUAL'] as const;
const LOCATION_SHARING_MODES = ['NONE', 'APPROXIMATE', 'EXACT'] as const;

interface TripRow {
  id: unknown;
  schema_version: unknown;
  name: unknown;
  created_by_member_id: unknown;
  created_at_ms: unknown;
  updated_at_ms: unknown;
  starts_at_ms: unknown;
  ends_at_ms: unknown;
  time_zone: unknown;
  status: unknown;
  default_sharing_mode: unknown;
  location_sharing_mode: unknown;
  target_replica_count: unknown;
  complete_keeper_count: unknown;
  membership_epoch: unknown;
  is_active: unknown;
}

const TRIP_COLUMNS = `
  id, schema_version, name, created_by_member_id, created_at_ms, updated_at_ms,
  starts_at_ms, ends_at_ms, time_zone, status, default_sharing_mode,
  location_sharing_mode, target_replica_count, complete_keeper_count,
  membership_epoch, is_active
`;

function mapTrip(row: TripRow): TripRecord {
  return {
    schemaVersion: requiredNumber('Trip', 'schema_version', row.schema_version),
    id: requiredString('Trip', 'id', row.id),
    name: requiredString('Trip', 'name', row.name),
    createdByMemberId: requiredString('Trip', 'created_by_member_id', row.created_by_member_id),
    createdAtMs: requiredNumber('Trip', 'created_at_ms', row.created_at_ms),
    updatedAtMs: requiredNumber('Trip', 'updated_at_ms', row.updated_at_ms),
    startsAtMs: requiredNumber('Trip', 'starts_at_ms', row.starts_at_ms),
    endsAtMs: nullableNumber('Trip', 'ends_at_ms', row.ends_at_ms),
    timeZone: requiredString('Trip', 'time_zone', row.time_zone),
    status: enumValue('Trip', 'status', row.status, TRIP_STATUSES) as TripStatus,
    defaultSharingMode: enumValue(
      'Trip',
      'default_sharing_mode',
      row.default_sharing_mode,
      SHARING_MODES,
    ) as SharingMode,
    locationSharingMode: enumValue(
      'Trip',
      'location_sharing_mode',
      row.location_sharing_mode,
      LOCATION_SHARING_MODES,
    ) as LocationSharingMode,
    targetReplicaCount: requiredNumber(
      'Trip',
      'target_replica_count',
      row.target_replica_count,
    ),
    completeKeeperCount: requiredNumber(
      'Trip',
      'complete_keeper_count',
      row.complete_keeper_count,
    ),
    membershipEpoch: requiredNumber('Trip', 'membership_epoch', row.membership_epoch),
    isActive: sqliteBoolean('Trip', 'is_active', row.is_active),
  };
}

export class SqliteTripRepository implements TripRepository {
  constructor(private readonly client: AirMeshDatabaseClient = databaseClient) {}

  async upsert(trip: TripRecord): Promise<void> {
    if (trip.isActive) {
      await this.client.transaction(async (database) => {
        await database.runAsync(
          'UPDATE trips SET is_active = 0 WHERE is_active = 1 AND id <> ?',
          trip.id,
        );
        await this.upsertOn(database, trip);
      });
      return;
    }

    await this.upsertOn(await this.client.connection(), trip);
  }

  async getById(id: string): Promise<TripRecord | null> {
    const row = await (await this.client.connection()).getFirstAsync<TripRow>(
      `SELECT ${TRIP_COLUMNS} FROM trips WHERE id = ?`,
      id,
    );
    return row ? mapTrip(row) : null;
  }

  async getActive(): Promise<TripRecord | null> {
    const row = await (await this.client.connection()).getFirstAsync<TripRow>(
      `SELECT ${TRIP_COLUMNS} FROM trips WHERE is_active = 1`,
    );
    return row ? mapTrip(row) : null;
  }

  async list(): Promise<TripRecord[]> {
    const rows = await (await this.client.connection()).getAllAsync<TripRow>(
      `SELECT ${TRIP_COLUMNS} FROM trips ORDER BY created_at_ms DESC, id ASC`,
    );
    return rows.map(mapTrip);
  }

  async setActive(id: string): Promise<void> {
    await this.client.transaction(async (database) => {
      const target = await database.getFirstAsync<{ id: string }>(
        'SELECT id FROM trips WHERE id = ?',
        id,
      );
      if (!target) {
        throw new RecordNotFoundError('Trip', id);
      }
      await database.runAsync('UPDATE trips SET is_active = 0 WHERE is_active = 1 AND id <> ?', id);
      await database.runAsync('UPDATE trips SET is_active = 1 WHERE id = ?', id);
    });
  }

  async clearActive(): Promise<void> {
    await (await this.client.connection()).runAsync(
      'UPDATE trips SET is_active = 0 WHERE is_active = 1',
    );
  }

  async remove(id: string): Promise<boolean> {
    const result = await (await this.client.connection()).runAsync(
      'DELETE FROM trips WHERE id = ?',
      id,
    );
    return result.changes > 0;
  }

  private async upsertOn(database: SQLiteDatabase, trip: TripRecord): Promise<void> {
    await database.runAsync(
      `INSERT INTO trips (
        id, schema_version, name, created_by_member_id, created_at_ms, updated_at_ms,
        starts_at_ms, ends_at_ms, time_zone, status, default_sharing_mode,
        location_sharing_mode, target_replica_count, complete_keeper_count,
        membership_epoch, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        schema_version = excluded.schema_version,
        name = excluded.name,
        created_by_member_id = excluded.created_by_member_id,
        created_at_ms = excluded.created_at_ms,
        updated_at_ms = excluded.updated_at_ms,
        starts_at_ms = excluded.starts_at_ms,
        ends_at_ms = excluded.ends_at_ms,
        time_zone = excluded.time_zone,
        status = excluded.status,
        default_sharing_mode = excluded.default_sharing_mode,
        location_sharing_mode = excluded.location_sharing_mode,
        target_replica_count = excluded.target_replica_count,
        complete_keeper_count = excluded.complete_keeper_count,
        membership_epoch = excluded.membership_epoch,
        is_active = excluded.is_active`,
      [
        trip.id,
        trip.schemaVersion,
        trip.name,
        trip.createdByMemberId,
        trip.createdAtMs,
        trip.updatedAtMs,
        trip.startsAtMs,
        trip.endsAtMs,
        trip.timeZone,
        trip.status,
        trip.defaultSharingMode,
        trip.locationSharingMode,
        trip.targetReplicaCount,
        trip.completeKeeperCount,
        trip.membershipEpoch,
        trip.isActive ? 1 : 0,
      ],
    );
  }
}
