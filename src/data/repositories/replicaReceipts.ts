import type { SQLiteDatabase } from 'expo-sqlite';

import {
  databaseClient,
  type AirMeshDatabaseClient,
} from '../database/client';
import { ImmutableRecordConflictError } from '../database/errors';
import type { ReplicaReceiptRecord } from '../types';
import type { ReplicaReceiptRepository } from './contracts';
import {
  enumValue,
  requiredNumber,
  requiredString,
} from './rowMapping';

const RECEIPT_STATUSES = ['VERIFIED', 'RELEASED', 'LOST'] as const;

interface ReplicaReceiptRow {
  trip_id: unknown;
  id: unknown;
  schema_version: unknown;
  media_id: unknown;
  resource_id: unknown;
  holder_member_id: unknown;
  holder_device_id: unknown;
  resource_sha256: unknown;
  resource_byte_length: unknown;
  status: unknown;
  verified_at_ms: unknown;
  updated_at_ms: unknown;
}

const RECEIPT_COLUMNS = `
  trip_id, id, schema_version, media_id, resource_id, holder_member_id, holder_device_id,
  resource_sha256, resource_byte_length, status, verified_at_ms, updated_at_ms
`;

function mapReceipt(row: ReplicaReceiptRow): ReplicaReceiptRecord {
  return {
    schemaVersion: requiredNumber(
      'ReplicaReceipt',
      'schema_version',
      row.schema_version,
    ),
    tripId: requiredString('ReplicaReceipt', 'trip_id', row.trip_id),
    id: requiredString('ReplicaReceipt', 'id', row.id),
    mediaId: requiredString('ReplicaReceipt', 'media_id', row.media_id),
    resourceId: requiredString('ReplicaReceipt', 'resource_id', row.resource_id),
    holderMemberId: requiredString(
      'ReplicaReceipt',
      'holder_member_id',
      row.holder_member_id,
    ),
    holderDeviceId: requiredString(
      'ReplicaReceipt',
      'holder_device_id',
      row.holder_device_id,
    ),
    resourceSha256: requiredString(
      'ReplicaReceipt',
      'resource_sha256',
      row.resource_sha256,
    ),
    resourceByteLength: requiredNumber(
      'ReplicaReceipt',
      'resource_byte_length',
      row.resource_byte_length,
    ),
    status: enumValue(
      'ReplicaReceipt',
      'status',
      row.status,
      RECEIPT_STATUSES,
    ),
    verifiedAtMs: requiredNumber(
      'ReplicaReceipt',
      'verified_at_ms',
      row.verified_at_ms,
    ),
    updatedAtMs: requiredNumber('ReplicaReceipt', 'updated_at_ms', row.updated_at_ms),
  };
}

function immutableReceiptEqual(
  left: ReplicaReceiptRecord,
  right: ReplicaReceiptRecord,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.id === right.id &&
    left.tripId === right.tripId &&
    left.mediaId === right.mediaId &&
    left.resourceId === right.resourceId &&
    left.holderMemberId === right.holderMemberId &&
    left.holderDeviceId === right.holderDeviceId &&
    left.resourceSha256 === right.resourceSha256 &&
    left.resourceByteLength === right.resourceByteLength &&
    left.verifiedAtMs === right.verifiedAtMs
  );
}

export class SqliteReplicaReceiptRepository implements ReplicaReceiptRepository {
  constructor(private readonly client: AirMeshDatabaseClient = databaseClient) {}

  async upsert(receipt: ReplicaReceiptRecord): Promise<void> {
    await this.client.transaction(async (database) => {
      const existing = await this.getByIdOn(database, receipt.tripId, receipt.id);
      if (existing) {
        if (!immutableReceiptEqual(existing, receipt)) {
          throw new ImmutableRecordConflictError('ReplicaReceipt', receipt.id);
        }
        await database.runAsync(
          `UPDATE replica_receipts
           SET status = ?, updated_at_ms = ?
           WHERE trip_id = ? AND id = ?`,
          [receipt.status, receipt.updatedAtMs, receipt.tripId, receipt.id],
        );
        return;
      }

      await database.runAsync(
        `INSERT INTO replica_receipts (
          trip_id, id, schema_version, media_id, resource_id, holder_member_id, holder_device_id,
          resource_sha256, resource_byte_length, status, verified_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          receipt.tripId,
          receipt.id,
          receipt.schemaVersion,
          receipt.mediaId,
          receipt.resourceId,
          receipt.holderMemberId,
          receipt.holderDeviceId,
          receipt.resourceSha256,
          receipt.resourceByteLength,
          receipt.status,
          receipt.verifiedAtMs,
          receipt.updatedAtMs,
        ],
      );
    });
  }

  async getById(tripId: string, receiptId: string): Promise<ReplicaReceiptRecord | null> {
    return this.getByIdOn(await this.client.connection(), tripId, receiptId);
  }

  private async getByIdOn(
    database: SQLiteDatabase,
    tripId: string,
    receiptId: string,
  ): Promise<ReplicaReceiptRecord | null> {
    const row = await database.getFirstAsync<ReplicaReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS}
       FROM replica_receipts
       WHERE trip_id = ? AND id = ?`,
      [tripId, receiptId],
    );
    return row ? mapReceipt(row) : null;
  }

  async listByResource(tripId: string, resourceId: string): Promise<ReplicaReceiptRecord[]> {
    const rows = await (await this.client.connection()).getAllAsync<ReplicaReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS}
       FROM replica_receipts
       WHERE trip_id = ? AND resource_id = ?
       ORDER BY holder_device_id ASC, id ASC`,
      [tripId, resourceId],
    );
    return rows.map(mapReceipt);
  }

  async listByHolder(tripId: string, holderMemberId: string): Promise<ReplicaReceiptRecord[]> {
    const rows = await (await this.client.connection()).getAllAsync<ReplicaReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS}
       FROM replica_receipts
       WHERE trip_id = ? AND holder_member_id = ?
       ORDER BY updated_at_ms DESC, resource_id ASC, id ASC`,
      [tripId, holderMemberId],
    );
    return rows.map(mapReceipt);
  }

  async countVerified(tripId: string, resourceId: string): Promise<number> {
    const row = await (await this.client.connection()).getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM replica_receipts
       WHERE trip_id = ? AND resource_id = ? AND status = 'VERIFIED'`,
      [tripId, resourceId],
    );
    return row?.count ?? 0;
  }
}
