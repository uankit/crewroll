import type { SQLiteDatabase } from 'expo-sqlite';

import {
  databaseClient,
  type AirMeshDatabaseClient,
} from '../database/client';
import {
  ImmutableRecordConflictError,
  RecordNotFoundError,
} from '../database/errors';
import type {
  ResourceAvailability,
  ResourceKind,
  ResourceRecord,
} from '../types';
import type { ResourceRepository } from './contracts';
import {
  enumValue,
  nullableNumber,
  nullableString,
  requiredNumber,
  requiredString,
} from './rowMapping';

const RESOURCE_KINDS = ['ORIGINAL', 'THUMBNAIL'] as const;
const AVAILABILITIES = ['missing', 'partial', 'available'] as const;

export interface ResourceRow {
  trip_id: unknown;
  id: unknown;
  schema_version: unknown;
  media_id: unknown;
  kind: unknown;
  mime_type: unknown;
  file_extension: unknown;
  byte_length: unknown;
  sha256: unknown;
  width: unknown;
  height: unknown;
  created_at_ms: unknown;
  availability: unknown;
  local_uri: unknown;
  verified_at_ms: unknown;
  updated_at_ms: unknown;
}

export const RESOURCE_COLUMN_NAMES = [
  'trip_id',
  'id',
  'schema_version',
  'media_id',
  'kind',
  'mime_type',
  'file_extension',
  'byte_length',
  'sha256',
  'width',
  'height',
  'created_at_ms',
  'availability',
  'local_uri',
  'verified_at_ms',
  'updated_at_ms',
] as const;

const RESOURCE_COLUMNS = RESOURCE_COLUMN_NAMES.join(', ');
const QUALIFIED_RESOURCE_COLUMNS = RESOURCE_COLUMN_NAMES
  .map((column) => `resources.${column} AS ${column}`)
  .join(', ');

export function mapResourceRow(row: ResourceRow): ResourceRecord {
  return {
    schemaVersion: requiredNumber('Resource', 'schema_version', row.schema_version),
    tripId: requiredString('Resource', 'trip_id', row.trip_id),
    id: requiredString('Resource', 'id', row.id),
    mediaId: requiredString('Resource', 'media_id', row.media_id),
    kind: enumValue('Resource', 'kind', row.kind, RESOURCE_KINDS) as ResourceKind,
    mimeType: requiredString('Resource', 'mime_type', row.mime_type),
    fileExtension: requiredString('Resource', 'file_extension', row.file_extension),
    byteLength: requiredNumber('Resource', 'byte_length', row.byte_length),
    sha256: requiredString('Resource', 'sha256', row.sha256),
    width: requiredNumber('Resource', 'width', row.width),
    height: requiredNumber('Resource', 'height', row.height),
    createdAtMs: requiredNumber('Resource', 'created_at_ms', row.created_at_ms),
    availability: enumValue(
      'Resource',
      'availability',
      row.availability,
      AVAILABILITIES,
    ) as ResourceAvailability,
    localUri: nullableString('Resource', 'local_uri', row.local_uri),
    verifiedAtMs: nullableNumber('Resource', 'verified_at_ms', row.verified_at_ms),
    updatedAtMs: requiredNumber('Resource', 'updated_at_ms', row.updated_at_ms),
  };
}

function normalizeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('limit must be a positive safe integer.');
  }
  return limit;
}

function immutableResourceEqual(left: ResourceRecord, right: ResourceRecord): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.id === right.id &&
    left.tripId === right.tripId &&
    left.mediaId === right.mediaId &&
    left.kind === right.kind &&
    left.mimeType === right.mimeType &&
    left.fileExtension === right.fileExtension &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256 &&
    left.width === right.width &&
    left.height === right.height &&
    left.createdAtMs === right.createdAtMs
  );
}

export class SqliteResourceRepository implements ResourceRepository {
  constructor(private readonly client: AirMeshDatabaseClient = databaseClient) {}

  async upsert(resource: ResourceRecord): Promise<void> {
    await this.client.transaction(async (database) => {
      const existing = await this.getByIdOn(database, resource.tripId, resource.id);
      if (existing) {
        if (!immutableResourceEqual(existing, resource)) {
          throw new ImmutableRecordConflictError('Resource', resource.id);
        }
        // A remote manifest, delayed ingestion retry, or losing transfer may
        // refresh metadata, but it must never erase a copy whose bytes were
        // already verified locally. Only markVerifiedLocalCopyLost may make
        // that transition, using the exact URI and verification generation.
        if (existing.availability === 'available' && resource.availability !== 'available') {
          return;
        }
        await database.runAsync(
          `UPDATE resources
           SET availability = ?, local_uri = ?, verified_at_ms = ?,
               updated_at_ms = MAX(updated_at_ms, ?)
           WHERE trip_id = ? AND id = ?`,
          [
            resource.availability,
            resource.localUri,
            resource.verifiedAtMs,
            resource.updatedAtMs,
            resource.tripId,
            resource.id,
          ],
        );
        return;
      }

      await database.runAsync(
        `INSERT INTO resources (
          trip_id, id, schema_version, media_id, kind, mime_type, file_extension, byte_length,
          sha256, width, height, created_at_ms, availability, local_uri,
          verified_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          resource.tripId,
          resource.id,
          resource.schemaVersion,
          resource.mediaId,
          resource.kind,
          resource.mimeType,
          resource.fileExtension,
          resource.byteLength,
          resource.sha256,
          resource.width,
          resource.height,
          resource.createdAtMs,
          resource.availability,
          resource.localUri,
          resource.verifiedAtMs,
          resource.updatedAtMs,
        ],
      );
    });
  }

  async getById(tripId: string, resourceId: string): Promise<ResourceRecord | null> {
    return this.getByIdOn(await this.client.connection(), tripId, resourceId);
  }

  private async getByIdOn(
    database: SQLiteDatabase,
    tripId: string,
    resourceId: string,
  ): Promise<ResourceRecord | null> {
    const row = await database.getFirstAsync<ResourceRow>(
      `SELECT ${RESOURCE_COLUMNS} FROM resources WHERE trip_id = ? AND id = ?`,
      [tripId, resourceId],
    );
    return row ? mapResourceRow(row) : null;
  }

  async listByTrip(tripId: string): Promise<ResourceRecord[]> {
    const rows = await (await this.client.connection()).getAllAsync<ResourceRow>(
      `SELECT ${RESOURCE_COLUMNS}
       FROM resources
       WHERE trip_id = ?
       ORDER BY media_id ASC, CASE kind WHEN 'THUMBNAIL' THEN 0 ELSE 1 END, id ASC`,
      tripId,
    );
    return rows.map(mapResourceRow);
  }

  async listByMedia(tripId: string, mediaId: string): Promise<ResourceRecord[]> {
    const rows = await (await this.client.connection()).getAllAsync<ResourceRow>(
      `SELECT ${RESOURCE_COLUMNS}
       FROM resources
       WHERE trip_id = ? AND media_id = ?
       ORDER BY CASE kind WHEN 'THUMBNAIL' THEN 0 ELSE 1 END, id ASC`,
      [tripId, mediaId],
    );
    return rows.map(mapResourceRow);
  }

  async listUnavailable(
    tripId: string,
    limit = 200,
    after: {
      readonly kind: ResourceKind;
      readonly createdAtMs: number;
      readonly id: string;
    } | null = null,
  ): Promise<ResourceRecord[]> {
    const kindRank = after?.kind === 'THUMBNAIL' ? 0 : 1;
    const cursorClause = after
      ? `AND (
           CASE resources.kind WHEN 'THUMBNAIL' THEN 0 ELSE 1 END > ?
           OR (
             CASE resources.kind WHEN 'THUMBNAIL' THEN 0 ELSE 1 END = ?
             AND (
               resources.created_at_ms > ?
               OR (resources.created_at_ms = ? AND resources.id > ?)
             )
           )
         )`
      : '';
    const parameters: (string | number)[] = after
      ? [
          tripId,
          kindRank,
          kindRank,
          after.createdAtMs,
          after.createdAtMs,
          after.id,
          normalizeLimit(limit),
        ]
      : [tripId, normalizeLimit(limit)];
    const rows = await (await this.client.connection()).getAllAsync<ResourceRow>(
      `SELECT ${QUALIFIED_RESOURCE_COLUMNS}
       FROM resources
       INNER JOIN media
         ON media.trip_id = resources.trip_id AND media.id = resources.media_id
       WHERE resources.trip_id = ?
         AND resources.availability <> 'available'
         AND media.share_status = 'PUBLISHED'
         ${cursorClause}
       ORDER BY CASE resources.kind WHEN 'THUMBNAIL' THEN 0 ELSE 1 END,
                resources.created_at_ms ASC, resources.id ASC
       LIMIT ?`,
      parameters,
    );
    return rows.map(mapResourceRow);
  }

  async setLocalAvailability(
    tripId: string,
    resourceId: string,
    availability: ResourceAvailability,
    localUri: string | null,
    verifiedAtMs: number | null,
    updatedAtMs: number,
  ): Promise<void> {
    const result = await (await this.client.connection()).runAsync(
      `UPDATE resources
       SET availability = ?, local_uri = ?, verified_at_ms = ?,
           updated_at_ms = MAX(updated_at_ms, ?)
       WHERE trip_id = ? AND id = ?
         AND (availability <> 'available' OR ? = 'available')`,
      [
        availability,
        localUri,
        verifiedAtMs,
        updatedAtMs,
        tripId,
        resourceId,
        availability,
      ],
    );
    if (result.changes === 1) return;
    const existing = await this.getById(tripId, resourceId);
    if (!existing) {
      throw new RecordNotFoundError('Resource', `${tripId}/${resourceId}`);
    }
    // Local availability is monotonic: a delayed offer may not erase a fully
    // verified target that another attempt committed first.
  }

  async markVerifiedLocalCopyLost(
    tripId: string,
    resourceId: string,
    expectedLocalUri: string,
    expectedVerifiedAtMs: number,
    expectedUpdatedAtMs: number,
    updatedAtMs: number,
  ): Promise<boolean> {
    if (!expectedLocalUri) {
      throw new RangeError('expectedLocalUri must be non-empty.');
    }
    if (!Number.isSafeInteger(expectedVerifiedAtMs) || expectedVerifiedAtMs < 0) {
      throw new RangeError('expectedVerifiedAtMs must be a non-negative safe integer.');
    }
    if (
      !Number.isSafeInteger(expectedUpdatedAtMs) ||
      expectedUpdatedAtMs < expectedVerifiedAtMs
    ) {
      throw new RangeError(
        'expectedUpdatedAtMs must be a safe integer at or after expectedVerifiedAtMs.',
      );
    }
    if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < expectedUpdatedAtMs) {
      throw new RangeError('updatedAtMs must be a safe integer at or after expectedUpdatedAtMs.');
    }

    const result = await (await this.client.connection()).runAsync(
      `UPDATE resources
       SET availability = 'missing', local_uri = NULL, verified_at_ms = NULL, updated_at_ms = ?
       WHERE trip_id = ? AND id = ?
         AND availability = 'available'
         AND local_uri = ?
         AND verified_at_ms = ?
         AND updated_at_ms = ?`,
      [
        updatedAtMs,
        tripId,
        resourceId,
        expectedLocalUri,
        expectedVerifiedAtMs,
        expectedUpdatedAtMs,
      ],
    );
    if (result.changes === 1) return true;
    const existing = await this.getById(tripId, resourceId);
    if (!existing) {
      throw new RecordNotFoundError('Resource', `${tripId}/${resourceId}`);
    }
    return false;
  }
}
