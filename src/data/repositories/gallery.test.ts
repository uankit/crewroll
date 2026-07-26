import { describe, expect, it, vi } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

import type { AirMeshDatabaseClient } from '../database/client';
import { SqliteGalleryRepository } from './gallery';

vi.mock('expo-sqlite', () => ({}));

describe('SqliteGalleryRepository', () => {
  it('uses one joined keyset query and asks for a sentinel row', async () => {
    const getAllAsync = vi.fn(async (
      _sql: string,
      _parameters: (string | number)[],
    ) => []);
    const database = { getAllAsync } as unknown as SQLiteDatabase;
    const client = {
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient;
    const repository = new SqliteGalleryRepository(client);

    await repository.listPage('trip:gallery-test', {
      limit: 50,
      cursor: { capturedAtMs: 2_000, mediaId: 'media:last-seen' },
    });

    expect(getAllAsync).toHaveBeenCalledTimes(1);
    const [sql, parameters] = getAllAsync.mock.calls[0]!;
    const normalizedSql = sql.replace(/\s+/g, ' ');
    expect(normalizedSql).toContain('LEFT JOIN resources AS original');
    expect(normalizedSql).toContain('LEFT JOIN resources AS thumbnail');
    expect(normalizedSql).toContain('m.captured_at_ms < ?');
    expect(normalizedSql).toContain('m.captured_at_ms = ? AND m.id > ?');
    expect(normalizedSql).not.toContain('OFFSET');
    expect(parameters).toEqual([
      'trip:gallery-test',
      2_000,
      2_000,
      'media:last-seen',
      51,
    ]);
  });

  it('bounds each page so a caller cannot recreate the old bulk gallery read', async () => {
    const repository = new SqliteGalleryRepository({} as AirMeshDatabaseClient);
    await expect(repository.listPage('trip:gallery-test', { limit: 501 })).rejects.toThrow(
      'limit must be an integer from 1 to 500',
    );
  });
});
