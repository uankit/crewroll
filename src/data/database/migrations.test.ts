import { describe, expect, it, vi } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

import { DATABASE_SCHEMA_VERSION, migrateDatabase } from './migrations';

vi.mock('expo-sqlite', () => ({}));

describe('database migrations', () => {
  it('adds bounded history and retention indexes when upgrading from schema 4', async () => {
    const statements: string[] = [];
    const database = {
      getFirstAsync: vi.fn(async (sql: string) => {
        expect(sql).toBe('PRAGMA user_version');
        return { user_version: 4 };
      }),
      getAllAsync: vi.fn(async (sql: string) => {
        expect(sql).toBe('PRAGMA foreign_key_check');
        return [];
      }),
      execAsync: vi.fn(async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
      }),
      withTransactionAsync: vi.fn(async (task: () => Promise<void>) => task()),
    } as unknown as SQLiteDatabase;

    await migrateDatabase(database);

    expect(DATABASE_SCHEMA_VERSION).toBe(5);
    expect(database.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(statements).toContainEqual(expect.stringContaining(
      'CREATE INDEX IF NOT EXISTS transfers_recent_index ON transfers(trip_id, updated_at DESC, id ASC)',
    ));
    expect(statements).toContainEqual(expect.stringContaining(
      "CREATE INDEX IF NOT EXISTS transfers_retention_index ON transfers(updated_at ASC) WHERE state IN ('completed', 'failed', 'cancelled')",
    ));
    expect(statements).toContainEqual(expect.stringContaining(
      "CREATE INDEX IF NOT EXISTS outbox_retention_index ON outbox(updated_at ASC) WHERE state = 'delivered'",
    ));
    expect(statements).toContainEqual(expect.stringContaining(
      "CREATE INDEX IF NOT EXISTS outbox_dead_letter_retention_index ON outbox(updated_at ASC) WHERE state = 'dead_letter'",
    ));
    expect(statements).toContainEqual(expect.stringContaining(
      "CREATE INDEX IF NOT EXISTS outbox_in_flight_wake_index ON outbox(trip_id, lease_expires_at ASC) WHERE state = 'in_flight'",
    ));
    expect(statements).toContainEqual(expect.stringContaining(
      "CREATE INDEX IF NOT EXISTS resources_unavailable_queue_index ON resources( trip_id, CASE kind WHEN 'THUMBNAIL' THEN 0 ELSE 1 END, created_at_ms ASC, id ASC ) WHERE availability <> 'available'",
    ));
    expect(statements).toContain('PRAGMA user_version = 5');
  });
});
