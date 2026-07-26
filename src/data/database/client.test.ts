import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExpoSqliteDatabaseClient } from './client';

const sqlite = vi.hoisted(() => {
  class FakeDatabase {
    readonly execAsync = vi.fn(async (_sql: string) => undefined);
    readonly getFirstAsync = vi.fn(async (sql: string) => {
      if (sql.includes('foreign_keys')) return { foreign_keys: 1 };
      if (sql.includes('journal_mode')) return { journal_mode: 'wal' };
      return null;
    });
    readonly closeAsync = vi.fn(async () => undefined);
  }

  const connections: FakeDatabase[] = [];
  const openDatabaseAsync = vi.fn(async (
    _databaseName: string,
    _options?: { useNewConnection?: boolean },
    _directory?: string,
  ) => {
    const database = new FakeDatabase();
    connections.push(database);
    return database;
  });
  return { connections, openDatabaseAsync };
});

const migrations = vi.hoisted(() => ({
  migrateDatabase: vi.fn(async () => undefined),
}));

vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: sqlite.openDatabaseAsync,
}));

vi.mock('./migrations', () => ({
  migrateDatabase: migrations.migrateDatabase,
}));

beforeEach(() => {
  sqlite.connections.length = 0;
  sqlite.openDatabaseAsync.mockClear();
  migrations.migrateDatabase.mockClear();
});

describe('ExpoSqliteDatabaseClient transaction connection', () => {
  it('reuses one configured connection and serializes concurrent transactions', async () => {
    const client = new ExpoSqliteDatabaseClient({ databaseName: 'test.db' });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = client.transaction(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
      return 1;
    });
    const second = client.transaction(async () => {
      order.push('second:start');
      return 2;
    });

    await vi.waitFor(() => expect(order).toEqual(['first:start']));
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);

    // One long-lived base connection and one long-lived transaction connection.
    expect(sqlite.openDatabaseAsync).toHaveBeenCalledTimes(2);
    expect(sqlite.openDatabaseAsync.mock.calls[1]?.[1]).toEqual({ useNewConnection: true });
    const transactionDatabase = sqlite.connections[1]!;
    expect(
      transactionDatabase.execAsync.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql === 'BEGIN IMMEDIATE'),
    ).toHaveLength(2);
    expect(
      transactionDatabase.execAsync.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql === 'COMMIT'),
    ).toHaveLength(2);

    await client.close();
    expect(sqlite.connections[0]?.closeAsync).toHaveBeenCalledTimes(1);
    expect(transactionDatabase.closeAsync).toHaveBeenCalledTimes(1);
  });

  it('rolls back a failed task and keeps the configured connection reusable', async () => {
    const client = new ExpoSqliteDatabaseClient({ databaseName: 'test.db' });
    const failure = new Error('task failed');

    await expect(client.transaction(async () => {
      throw failure;
    })).rejects.toBe(failure);
    await expect(client.transaction(async () => 'recovered')).resolves.toBe('recovered');

    expect(sqlite.openDatabaseAsync).toHaveBeenCalledTimes(2);
    const statements = sqlite.connections[1]!.execAsync.mock.calls.map(([sql]) => sql);
    expect(statements.filter((sql) => sql === 'ROLLBACK')).toHaveLength(1);
    expect(statements.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
    await client.close();
  });
});
