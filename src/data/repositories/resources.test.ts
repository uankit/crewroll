import { describe, expect, it, vi } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

import type { AirMeshDatabaseClient } from '../database/client';
import { SqliteResourceRepository } from './resources';

vi.mock('expo-sqlite', () => ({}));

describe('SqliteResourceRepository unavailable-resource priority', () => {
  it('only schedules published, non-tombstoned media and bounds each reconciliation read', async () => {
    const getAllAsync = vi.fn(async (_sql: string, _parameters: unknown) => []);
    const database = { getAllAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteResourceRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await repository.listUnavailable('trip:resource-test', 32);

    const [sql, parameters] = getAllAsync.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain(
      'INNER JOIN media ON media.trip_id = resources.trip_id AND media.id = resources.media_id',
    );
    expect(normalized).toContain("AND media.share_status = 'PUBLISHED'");
    expect(normalized).toContain(
      "ORDER BY CASE resources.kind WHEN 'THUMBNAIL' THEN 0 ELSE 1 END, resources.created_at_ms ASC, resources.id ASC LIMIT ?",
    );
    expect(parameters).toEqual(['trip:resource-test', 32]);
  });

  it('uses a stable kind/time/id keyset cursor for fair bounded scans', async () => {
    const getAllAsync = vi.fn(async (_sql: string, _parameters: unknown) => []);
    const database = { getAllAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteResourceRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await repository.listUnavailable('trip:resource-test', 32, {
      kind: 'THUMBNAIL',
      createdAtMs: 1_500,
      id: 'resource:cursor',
    });

    const [sql, parameters] = getAllAsync.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain(
      "CASE resources.kind WHEN 'THUMBNAIL' THEN 0 ELSE 1 END > ?",
    );
    expect(normalized).toContain(
      'resources.created_at_ms > ? OR (resources.created_at_ms = ? AND resources.id > ?)',
    );
    expect(parameters).toEqual([
      'trip:resource-test',
      0,
      0,
      1_500,
      1_500,
      'resource:cursor',
      32,
    ]);
  });

  it('does not let a stale partial offer downgrade an available resource', async () => {
    const runAsync = vi.fn(async (_sql: string, _parameters: unknown) => ({ changes: 1 }));
    const database = { runAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteResourceRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await repository.setLocalAvailability(
      'trip:resource-test',
      'resource:one',
      'partial',
      null,
      null,
      2_000,
    );

    const [sql, parameters] = runAsync.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain('updated_at_ms = MAX(updated_at_ms, ?)');
    expect(normalized).toContain(
      "AND (availability <> 'available' OR ? = 'available')",
    );
    expect(parameters).toEqual([
      'partial',
      null,
      null,
      2_000,
      'trip:resource-test',
      'resource:one',
      'partial',
    ]);
  });

  it('makes verified loss an explicit compare-and-set against URI and verification time', async () => {
    const runAsync = vi.fn(async (_sql: string, _parameters: unknown) => ({ changes: 1 }));
    const database = { runAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteResourceRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await expect(repository.markVerifiedLocalCopyLost(
      'trip:resource-test',
      'resource:one',
      'file:///verified/original.jpg',
      1_500,
      1_750,
      2_000,
    )).resolves.toBe(true);

    const [sql, parameters] = runAsync.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain(
      "SET availability = 'missing', local_uri = NULL, verified_at_ms = NULL",
    );
    expect(normalized).toContain(
      "availability = 'available' AND local_uri = ? AND verified_at_ms = ? AND updated_at_ms = ?",
    );
    expect(parameters).toEqual([
      2_000,
      'trip:resource-test',
      'resource:one',
      'file:///verified/original.jpg',
      1_500,
      1_750,
    ]);
  });

  it('preserves a concurrently replaced verified copy when a loss observation is stale', async () => {
    const runAsync = vi.fn(async () => ({ changes: 0 }));
    const getFirstAsync = vi.fn(async () => ({
      trip_id: 'trip:resource-test',
      id: 'resource:one',
      schema_version: 1,
      media_id: 'media:one',
      kind: 'ORIGINAL',
      mime_type: 'image/jpeg',
      file_extension: 'jpg',
      byte_length: 12,
      sha256: 'a'.repeat(64),
      width: 12,
      height: 12,
      created_at_ms: 1_000,
      availability: 'available',
      local_uri: 'file:///replacement/original.jpg',
      verified_at_ms: 1_900,
      updated_at_ms: 1_900,
    }));
    const database = { runAsync, getFirstAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteResourceRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await expect(repository.markVerifiedLocalCopyLost(
      'trip:resource-test',
      'resource:one',
      'file:///old/original.jpg',
      1_500,
      1_500,
      2_000,
    )).resolves.toBe(false);
  });

  it('does not let generic upsert downgrade an available local copy', async () => {
    const runAsync = vi.fn(async () => ({ changes: 1 }));
    const getFirstAsync = vi.fn(async () => ({
      trip_id: 'trip:resource-test',
      id: 'resource:one',
      schema_version: 1,
      media_id: 'media:one',
      kind: 'ORIGINAL',
      mime_type: 'image/jpeg',
      file_extension: 'jpg',
      byte_length: 12,
      sha256: 'a'.repeat(64),
      width: 12,
      height: 12,
      created_at_ms: 1_000,
      availability: 'available',
      local_uri: 'file:///verified/original.jpg',
      verified_at_ms: 1_500,
      updated_at_ms: 1_500,
    }));
    const database = { getFirstAsync, runAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteResourceRepository({
      transaction: async (task: (value: SQLiteDatabase) => Promise<unknown>) => task(database),
    } as unknown as AirMeshDatabaseClient);

    await repository.upsert({
      tripId: 'trip:resource-test',
      id: 'resource:one',
      schemaVersion: 1,
      mediaId: 'media:one',
      kind: 'ORIGINAL',
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      byteLength: 12,
      sha256: 'a'.repeat(64),
      width: 12,
      height: 12,
      createdAtMs: 1_000,
      availability: 'partial',
      localUri: null,
      verifiedAtMs: null,
      updatedAtMs: 2_000,
    });

    expect(runAsync).not.toHaveBeenCalled();
  });
});
