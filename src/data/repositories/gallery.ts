import {
  databaseClient,
  type AirMeshDatabaseClient,
} from '../database/client';
import type {
  GalleryCursor,
  GalleryPage,
  GalleryRepository,
} from './contracts';
import {
  MEDIA_COLUMN_NAMES,
  mapMediaRow,
  type MediaRow,
} from './media';
import {
  RESOURCE_COLUMN_NAMES,
  mapResourceRow,
  type ResourceRow,
} from './resources';

const DEFAULT_PAGE_SIZE = 120;
const MAX_PAGE_SIZE = 500;

type JoinedGalleryRow = Record<string, unknown>;

const GALLERY_COLUMNS = [
  ...aliasedColumns('m', 'media', MEDIA_COLUMN_NAMES),
  ...aliasedColumns('original', 'original', RESOURCE_COLUMN_NAMES),
  ...aliasedColumns('thumbnail', 'thumbnail', RESOURCE_COLUMN_NAMES),
].join(', ');

/** Keyset-paged gallery read model: one SQLite query supplies media and both resources. */
export class SqliteGalleryRepository implements GalleryRepository {
  constructor(private readonly client: AirMeshDatabaseClient = databaseClient) {}

  async listPage(
    tripId: string,
    options: { limit?: number; cursor?: GalleryCursor | null } = {},
  ): Promise<GalleryPage> {
    if (!tripId.trim()) throw new RangeError('tripId is required.');
    const limit = normalizeLimit(options.limit ?? DEFAULT_PAGE_SIZE);
    const cursor = normalizeCursor(options.cursor ?? null);
    const cursorClause = cursor
      ? `AND (
          m.captured_at_ms < ?
          OR (m.captured_at_ms = ? AND m.id > ?)
        )`
      : '';
    const parameters: (string | number)[] = cursor
      ? [tripId, cursor.capturedAtMs, cursor.capturedAtMs, cursor.mediaId, limit + 1]
      : [tripId, limit + 1];

    const rows = await (await this.client.connection()).getAllAsync<JoinedGalleryRow>(
      `SELECT ${GALLERY_COLUMNS}
       FROM media AS m
       LEFT JOIN resources AS original
         ON original.trip_id = m.trip_id
        AND original.id = m.original_resource_id
        AND original.kind = 'ORIGINAL'
       LEFT JOIN resources AS thumbnail
         ON thumbnail.trip_id = m.trip_id
        AND thumbnail.id = m.thumbnail_resource_id
        AND thumbnail.kind = 'THUMBNAIL'
       WHERE m.trip_id = ?
         AND m.tombstoned_at_ms IS NULL
         ${cursorClause}
       ORDER BY m.captured_at_ms DESC, m.id ASC
       LIMIT ?`,
      parameters,
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((row) => ({
      media: mapMediaRow(
        prefixedRow(row, 'media', MEDIA_COLUMN_NAMES) as unknown as MediaRow,
      ),
      original: mapOptionalResource(row, 'original'),
      thumbnail: mapOptionalResource(row, 'thumbnail'),
    }));
    const last = items.at(-1)?.media;

    return {
      items,
      nextCursor: hasMore && last
        ? { capturedAtMs: last.capturedAtMs, mediaId: last.id }
        : null,
    };
  }
}

function aliasedColumns(
  table: string,
  prefix: string,
  columns: readonly string[],
): string[] {
  return columns.map((column) => `${table}.${column} AS ${prefix}_${column}`);
}

function prefixedRow(
  row: JoinedGalleryRow,
  prefix: string,
  columns: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    columns.map((column) => [column, row[`${prefix}_${column}`]]),
  );
}

function mapOptionalResource(
  row: JoinedGalleryRow,
  prefix: 'original' | 'thumbnail',
) {
  if (row[`${prefix}_id`] === null || row[`${prefix}_id`] === undefined) return null;
  return mapResourceRow(
    prefixedRow(row, prefix, RESOURCE_COLUMN_NAMES) as unknown as ResourceRow,
  );
}

function normalizeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return limit;
}

function normalizeCursor(cursor: GalleryCursor | null): GalleryCursor | null {
  if (cursor === null) return null;
  if (
    !Number.isSafeInteger(cursor.capturedAtMs) ||
    cursor.capturedAtMs < 0 ||
    !cursor.mediaId.trim()
  ) {
    throw new RangeError('cursor must contain a non-negative capturedAtMs and mediaId.');
  }
  return cursor;
}
