import { describe, expect, it, vi } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

import type { AirMeshDatabaseClient } from '../database/client';
import { SqliteOutboxRepository } from './outbox';

vi.mock('expo-sqlite', () => ({}));

describe('SqliteOutboxRepository retention', () => {
  it('seeks pending availability and in-flight lease clocks separately', async () => {
    const getFirstAsync = vi.fn(async (_sql: string, _parameters: unknown) => ({
      next_wake_at: 123_456,
    }));
    const database = { getFirstAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteOutboxRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await expect(repository.getNextWakeAt('trip:one')).resolves.toBe(123_456);

    const [sql, parameters] = getFirstAsync.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain(
      "SELECT MIN(available_at) AS next_wake_at FROM outbox WHERE trip_id = ? AND state = 'pending'",
    );
    expect(normalized).toContain(
      "SELECT MIN(lease_expires_at) AS next_wake_at FROM outbox WHERE trip_id = ? AND state = 'in_flight'",
    );
    expect(normalized).not.toContain('CASE');
    expect(parameters).toEqual(['trip:one', 'trip:one']);
  });

  it('removes only delivered rows older than an explicit cutoff', async () => {
    const runAsync = vi.fn(async (_sql: string, _parameters: unknown) => ({ changes: 4 }));
    const database = { runAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteOutboxRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await expect(repository.removeDeliveredBefore(123_456)).resolves.toBe(4);

    const [sql, parameters] = runAsync.mock.calls[0]!;
    expect(String(sql).replace(/\s+/g, ' ')).toContain(
      "DELETE FROM outbox WHERE state = 'delivered' AND updated_at < ?",
    );
    expect(parameters).toBe(123_456);
  });

  it('retains recent diagnostics while pruning old dead letters', async () => {
    const runAsync = vi.fn(async (_sql: string, _parameters: unknown) => ({ changes: 2 }));
    const database = { runAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteOutboxRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await expect(repository.removeDeadLetterBefore(654_321)).resolves.toBe(2);

    const [sql, parameters] = runAsync.mock.calls[0]!;
    expect(String(sql).replace(/\s+/g, ' ')).toContain(
      "DELETE FROM outbox WHERE state = 'dead_letter' AND updated_at < ?",
    );
    expect(parameters).toBe(654_321);
  });

  it('rejects invalid cutoffs before opening the database', async () => {
    const connection = vi.fn(async () => ({}) as SQLiteDatabase);
    const repository = new SqliteOutboxRepository({
      connection,
    } as unknown as AirMeshDatabaseClient);

    await expect(repository.removeDeliveredBefore(-1)).rejects.toThrow(
      'cutoffMs must be a non-negative safe integer',
    );
    await expect(repository.removeDeliveredBefore(Number.MAX_VALUE)).rejects.toThrow(
      'cutoffMs must be a non-negative safe integer',
    );
    await expect(repository.removeDeadLetterBefore(-1)).rejects.toThrow(
      'cutoffMs must be a non-negative safe integer',
    );
    expect(connection).not.toHaveBeenCalled();
  });
});
