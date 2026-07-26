import {
  databaseClient,
  type AirMeshDatabaseClient,
} from '../database/client';
import { PersistenceDecodingError } from '../database/errors';
import type {
  JsonValue,
  MediaLocation,
  MediaRecord,
  MediaShareStatus,
} from '../types';
import type { MediaRepository } from './contracts';
import {
  decodeNullableJson,
  encodeNullableJson,
  enumValue,
  nullableNumber,
  nullableString,
  requiredNumber,
  requiredString,
} from './rowMapping';

const MEDIA_SOURCES = ['SYSTEM_LIBRARY'] as const;
const MEDIA_TYPES = ['IMAGE'] as const;
const SHARE_STATUSES = ['PRIVATE', 'QUEUED', 'PUBLISHED', 'TOMBSTONED'] as const;

export interface MediaRow {
  trip_id: unknown;
  id: unknown;
  schema_version: unknown;
  origin_member_id: unknown;
  origin_device_id: unknown;
  origin_sequence: unknown;
  source_asset_id: unknown;
  source: unknown;
  media_type: unknown;
  share_status: unknown;
  captured_at_ms: unknown;
  capture_timezone_offset_minutes: unknown;
  capture_local_date: unknown;
  ingested_at_ms: unknown;
  published_at_ms: unknown;
  tombstoned_at_ms: unknown;
  location_json: unknown;
  original_resource_id: unknown;
  thumbnail_resource_id: unknown;
}

export const MEDIA_COLUMN_NAMES = [
  'trip_id',
  'id',
  'schema_version',
  'origin_member_id',
  'origin_device_id',
  'origin_sequence',
  'source_asset_id',
  'source',
  'media_type',
  'share_status',
  'captured_at_ms',
  'capture_timezone_offset_minutes',
  'capture_local_date',
  'ingested_at_ms',
  'published_at_ms',
  'tombstoned_at_ms',
  'location_json',
  'original_resource_id',
  'thumbnail_resource_id',
] as const;

const MEDIA_COLUMNS = MEDIA_COLUMN_NAMES.join(', ');

function isSafeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function mapLocation(value: unknown): MediaLocation | null {
  const location = decodeNullableJson('Media', 'location_json', value);
  if (location === null) {
    return null;
  }
  if (Array.isArray(location) || typeof location !== 'object') {
    throw new PersistenceDecodingError('Media', 'location_json', value);
  }

  if (
    location.kind === 'EXACT' &&
    Number.isSafeInteger(location.latitudeE7) &&
    Number.isSafeInteger(location.longitudeE7) &&
    (location.accuracyMeters === null || isSafeNumber(location.accuracyMeters))
  ) {
    return {
      kind: 'EXACT',
      latitudeE7: location.latitudeE7 as number,
      longitudeE7: location.longitudeE7 as number,
      accuracyMeters: location.accuracyMeters as number | null,
    };
  }

  if (location.kind === 'APPROXIMATE' && typeof location.cellId === 'string') {
    return { kind: 'APPROXIMATE', cellId: location.cellId };
  }

  throw new PersistenceDecodingError('Media', 'location_json', value);
}

export function mapMediaRow(row: MediaRow): MediaRecord {
  return {
    schemaVersion: requiredNumber('Media', 'schema_version', row.schema_version),
    tripId: requiredString('Media', 'trip_id', row.trip_id),
    id: requiredString('Media', 'id', row.id),
    originMemberId: requiredString('Media', 'origin_member_id', row.origin_member_id),
    originDeviceId: requiredString('Media', 'origin_device_id', row.origin_device_id),
    originSequence: requiredNumber('Media', 'origin_sequence', row.origin_sequence),
    sourceAssetId: nullableString('Media', 'source_asset_id', row.source_asset_id),
    source: enumValue('Media', 'source', row.source, MEDIA_SOURCES),
    mediaType: enumValue('Media', 'media_type', row.media_type, MEDIA_TYPES),
    shareStatus: enumValue(
      'Media',
      'share_status',
      row.share_status,
      SHARE_STATUSES,
    ) as MediaShareStatus,
    capturedAtMs: requiredNumber('Media', 'captured_at_ms', row.captured_at_ms),
    captureTimeZoneOffsetMinutes: requiredNumber(
      'Media',
      'capture_timezone_offset_minutes',
      row.capture_timezone_offset_minutes,
    ),
    captureLocalDate: requiredString('Media', 'capture_local_date', row.capture_local_date),
    ingestedAtMs: requiredNumber('Media', 'ingested_at_ms', row.ingested_at_ms),
    publishedAtMs: nullableNumber('Media', 'published_at_ms', row.published_at_ms),
    tombstonedAtMs: nullableNumber('Media', 'tombstoned_at_ms', row.tombstoned_at_ms),
    location: mapLocation(row.location_json),
    originalResourceId: requiredString(
      'Media',
      'original_resource_id',
      row.original_resource_id,
    ),
    thumbnailResourceId: nullableString(
      'Media',
      'thumbnail_resource_id',
      row.thumbnail_resource_id,
    ),
  };
}

function normalizeWindow(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return resolved;
}

export class SqliteMediaRepository implements MediaRepository {
  constructor(private readonly client: AirMeshDatabaseClient = databaseClient) {}

  async upsert(media: MediaRecord): Promise<void> {
    await (await this.client.connection()).runAsync(
      `INSERT INTO media (
        trip_id, id, schema_version, origin_member_id, origin_device_id, origin_sequence, source_asset_id, source,
        media_type, share_status, captured_at_ms, capture_timezone_offset_minutes,
        capture_local_date, ingested_at_ms, published_at_ms, tombstoned_at_ms,
        location_json, original_resource_id, thumbnail_resource_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trip_id, id) DO UPDATE SET
        schema_version = excluded.schema_version,
        origin_member_id = excluded.origin_member_id,
        origin_device_id = excluded.origin_device_id,
        origin_sequence = excluded.origin_sequence,
        source_asset_id = excluded.source_asset_id,
        source = excluded.source,
        media_type = excluded.media_type,
        share_status = excluded.share_status,
        captured_at_ms = excluded.captured_at_ms,
        capture_timezone_offset_minutes = excluded.capture_timezone_offset_minutes,
        capture_local_date = excluded.capture_local_date,
        ingested_at_ms = excluded.ingested_at_ms,
        published_at_ms = excluded.published_at_ms,
        tombstoned_at_ms = excluded.tombstoned_at_ms,
        location_json = excluded.location_json,
        original_resource_id = excluded.original_resource_id,
        thumbnail_resource_id = excluded.thumbnail_resource_id`,
      [
        media.tripId,
        media.id,
        media.schemaVersion,
        media.originMemberId,
        media.originDeviceId,
        media.originSequence,
        media.sourceAssetId,
        media.source,
        media.mediaType,
        media.shareStatus,
        media.capturedAtMs,
        media.captureTimeZoneOffsetMinutes,
        media.captureLocalDate,
        media.ingestedAtMs,
        media.publishedAtMs,
        media.tombstonedAtMs,
        encodeNullableJson(media.location as JsonValue | null),
        media.originalResourceId,
        media.thumbnailResourceId,
      ],
    );
  }

  async getById(tripId: string, mediaId: string): Promise<MediaRecord | null> {
    const row = await (await this.client.connection()).getFirstAsync<MediaRow>(
      `SELECT ${MEDIA_COLUMNS} FROM media WHERE trip_id = ? AND id = ?`,
      [tripId, mediaId],
    );
    return row ? mapMediaRow(row) : null;
  }

  async getByOrigin(
    tripId: string,
    originDeviceId: string,
    originSequence: number,
  ): Promise<MediaRecord | null> {
    const row = await (await this.client.connection()).getFirstAsync<MediaRow>(
      `SELECT ${MEDIA_COLUMNS}
       FROM media
       WHERE trip_id = ? AND origin_device_id = ? AND origin_sequence = ?`,
      [tripId, originDeviceId, originSequence],
    );
    return row ? mapMediaRow(row) : null;
  }

  async getBySourceAssetId(
    tripId: string,
    originDeviceId: string,
    sourceAssetId: string,
  ): Promise<MediaRecord | null> {
    const row = await (await this.client.connection()).getFirstAsync<MediaRow>(
      `SELECT ${MEDIA_COLUMNS}
       FROM media
       WHERE trip_id = ? AND origin_device_id = ? AND source_asset_id = ?`,
      [tripId, originDeviceId, sourceAssetId],
    );
    return row ? mapMediaRow(row) : null;
  }

  async listByTrip(
    tripId: string,
    options: {
      originMemberId?: string;
      includeTombstoned?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<MediaRecord[]> {
    const conditions = ['trip_id = ?'];
    const parameters: (string | number)[] = [tripId];
    if (options.originMemberId) {
      conditions.push('origin_member_id = ?');
      parameters.push(options.originMemberId);
    }
    if (!options.includeTombstoned) {
      conditions.push('tombstoned_at_ms IS NULL');
    }

    const limit = normalizeWindow(options.limit, 200, 'limit');
    const offset = normalizeWindow(options.offset, 0, 'offset');
    parameters.push(limit, offset);

    const rows = await (await this.client.connection()).getAllAsync<MediaRow>(
      `SELECT ${MEDIA_COLUMNS}
       FROM media
       WHERE ${conditions.join(' AND ')}
       ORDER BY captured_at_ms DESC, id ASC
       LIMIT ? OFFSET ?`,
      parameters,
    );
    return rows.map(mapMediaRow);
  }
}
