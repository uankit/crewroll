import { describe, expect, it, vi } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

import type { AirMeshDatabaseClient } from '../database/client';
import type { TransferRecord } from '../types';
import { SqliteTransferRepository } from './transfers';

vi.mock('expo-sqlite', () => ({}));

function transfer(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    tripId: 'trip:transfer-test',
    id: 'transfer:one',
    resourceId: 'resource:one',
    peerMemberId: 'member:peer',
    direction: 'download',
    state: 'transferring',
    bytesTransferred: 0,
    totalBytes: 10,
    chunkSize: 10,
    nextChunkIndex: 0,
    attemptCount: 0,
    lastError: null,
    startedAt: 1_000,
    completedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function transferRow(record: TransferRecord): Record<string, unknown> {
  return {
    trip_id: record.tripId,
    id: record.id,
    resource_id: record.resourceId,
    peer_member_id: record.peerMemberId,
    direction: record.direction,
    state: record.state,
    bytes_transferred: record.bytesTransferred,
    total_bytes: record.totalBytes,
    chunk_size: record.chunkSize,
    next_chunk_index: record.nextChunkIndex,
    attempt_count: record.attemptCount,
    last_error: record.lastError,
    started_at: record.startedAt,
    completed_at: record.completedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

describe('SqliteTransferRepository recovery reads', () => {
  it('never lets a generic upsert reopen a terminal transfer', async () => {
    const runAsync = vi.fn(async (_sql: string, _parameters: unknown) => ({ changes: 1 }));
    const database = { runAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteTransferRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await repository.upsert(transfer());

    const [sql] = runAsync.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain(
      "WHERE transfers.state IN ('queued', 'transferring', 'verifying', 'paused')",
    );
    expect(normalized).toContain('transfers.resource_id = excluded.resource_id');
    expect(normalized).toContain('transfers.chunk_size = excluded.chunk_size');
    expect(normalized).toContain(
      'transfers.bytes_transferred <= excluded.bytes_transferred',
    );
    expect(normalized).toContain(
      'transfers.next_chunk_index <= excluded.next_chunk_index',
    );
    expect(normalized).not.toContain('resource_id = excluded.resource_id,');
  });

  it('rejects immutable context changes after an upsert compare-and-set miss', async () => {
    const existing = transfer();
    const runAsync = vi.fn(async () => ({ changes: 0 }));
    const getFirstAsync = vi.fn(async () => transferRow(existing));
    const database = { runAsync, getFirstAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteTransferRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await expect(repository.upsert({
      ...existing,
      peerMemberId: 'member:attacker',
      updatedAt: 2_000,
    })).rejects.toThrow('different immutable content');
  });

  it('rejects checkpoint rewinds and illegal verifying-to-transferring transitions', async () => {
    const existing = transfer({
      state: 'verifying',
      bytesTransferred: 10,
      nextChunkIndex: 1,
      updatedAt: 2_000,
    });
    const runAsync = vi.fn(async () => ({ changes: 0 }));
    const getFirstAsync = vi.fn(async () => transferRow(existing));
    const database = { runAsync, getFirstAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteTransferRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await expect(repository.upsert({
      ...existing,
      state: 'transferring',
      updatedAt: 3_000,
    })).rejects.toThrow("Illegal transfer transition from 'verifying' to 'transferring'");

    await expect(repository.upsert({
      ...existing,
      state: 'paused',
      bytesTransferred: 0,
      nextChunkIndex: 0,
      updatedAt: 3_000,
    })).rejects.toThrow('checkpoints must be monotonic');
  });

  it('keeps terminal attempts immutable even when a stale writer tries to reopen them', async () => {
    const existing = transfer({
      state: 'completed',
      bytesTransferred: 10,
      nextChunkIndex: 1,
      completedAt: 2_000,
      updatedAt: 2_000,
    });
    const runAsync = vi.fn(async () => ({ changes: 0 }));
    const getFirstAsync = vi.fn(async () => transferRow(existing));
    const database = { runAsync, getFirstAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteTransferRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await expect(repository.upsert({
      ...existing,
      state: 'queued',
      completedAt: null,
      updatedAt: 3_000,
    })).rejects.toThrow("Transfer 'transfer:one' is already terminal");

    await expect(repository.upsert(existing)).resolves.toBeUndefined();
  });

  it('guards updateProgress with monotonic bytes, chunk index, time, and legal states', async () => {
    const runAsync = vi.fn(async (_sql: string, _parameters: unknown) => ({ changes: 1 }));
    const database = { runAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteTransferRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await repository.updateProgress(
      'trip:transfer-test',
      'transfer:one',
      10,
      1,
      'completed',
      2_000,
    );

    const [sql] = runAsync.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain('bytes_transferred <= ? AND next_chunk_index <= ?');
    expect(normalized).toContain('updated_at = MAX(updated_at, ?)');
    expect(normalized).toContain('total_bytes >= ?');
    expect(normalized).toContain("OR (? = 'completed')");
    await expect(repository.updateProgress(
      'trip:transfer-test',
      'transfer:one',
      10,
      1,
      'failed',
      2_000,
    )).rejects.toThrow("updateProgress cannot transition a transfer to 'failed'");
  });

  it('keeps failed and cancelled rows out of the recoverable active set', async () => {
    const getAllAsync = vi.fn(async (_sql: string, _parameters: unknown) => []);
    const database = { getAllAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteTransferRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await repository.listActive('trip:transfer-test');

    const [sql, parameters] = getAllAsync.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain(
      "state IN ('queued', 'transferring', 'verifying', 'paused')",
    );
    expect(normalized).not.toContain("state NOT IN ('completed', 'cancelled')");
    expect(parameters).toBe('trip:transfer-test');
  });

  it('offers a bounded recent-attempt read for presentation, including terminal rows', async () => {
    const getAllAsync = vi.fn(async (_sql: string, _parameters: unknown) => []);
    const database = { getAllAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteTransferRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await repository.listRecent('trip:transfer-test', 42);

    const [sql, parameters] = getAllAsync.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain('WHERE trip_id = ? ORDER BY updated_at DESC, id ASC LIMIT ?');
    expect(normalized).not.toContain('state IN');
    expect(parameters).toEqual(['trip:transfer-test', 42]);
    await expect(repository.listRecent('trip:transfer-test', 1_001)).rejects.toThrow(
      'limit must be an integer from 1 to 1,000',
    );
  });

  it('removes only terminal history older than an explicit retention cutoff', async () => {
    const runAsync = vi.fn(async (_sql: string, _parameters: unknown) => ({ changes: 7 }));
    const database = { runAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteTransferRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await expect(repository.removeTerminalBefore(86_400_000)).resolves.toBe(7);

    const [sql, parameters] = runAsync.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain(
      "WHERE state IN ('completed', 'failed', 'cancelled') AND updated_at < ?",
    );
    expect(normalized).not.toContain("'queued'");
    expect(normalized).not.toContain("'transferring'");
    expect(normalized).not.toContain("'verifying'");
    expect(normalized).not.toContain("'paused'");
    expect(parameters).toBe(86_400_000);
    await expect(repository.removeTerminalBefore(-1)).rejects.toThrow(
      'cutoffMs must be a non-negative safe integer',
    );
  });

  it('pauses recoverable work without repeatedly incrementing an already-paused attempt', async () => {
    const runAsync = vi.fn(async (_sql: string, _parameters: unknown) => ({ changes: 1 }));
    const database = { runAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteTransferRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await repository.markPaused(
      'trip:transfer-test',
      'transfer:one',
      'PEER_DISCONNECTED',
      2_000,
    );

    const [sql, parameters] = runAsync.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain(
      "attempt_count = attempt_count + CASE WHEN state = 'paused' THEN 0 ELSE 1 END",
    );
    expect(parameters).toEqual([
      'PEER_DISCONNECTED',
      2_000,
      'trip:transfer-test',
      'transfer:one',
    ]);
  });

  it('cancels only recoverable attempts so a completion race cannot regress', async () => {
    const runAsync = vi.fn(async (_sql: string, _parameters: unknown) => ({ changes: 1 }));
    const database = { runAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteTransferRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await repository.markCancelled(
      'trip:transfer-test',
      'transfer:sibling',
      'RESOURCE_AVAILABLE_FROM_ANOTHER_ATTEMPT',
      3_000,
    );

    const [sql, parameters] = runAsync.mock.calls[0]!;
    expect(String(sql).replace(/\s+/g, ' ')).toContain(
      "state IN ('queued', 'transferring', 'verifying', 'paused')",
    );
    expect(parameters).toEqual([
      'RESOURCE_AVAILABLE_FROM_ANOTHER_ATTEMPT',
      3_000,
      'trip:transfer-test',
      'transfer:sibling',
    ]);
  });

  it('marks failures only from recoverable states so delayed errors preserve terminal rows', async () => {
    const runAsync = vi.fn(async (_sql: string, _parameters: unknown) => ({ changes: 1 }));
    const database = { runAsync } as unknown as SQLiteDatabase;
    const repository = new SqliteTransferRepository({
      connection: async () => database,
    } as unknown as AirMeshDatabaseClient);

    await repository.markFailed('trip:transfer-test', 'transfer:one', 'CHUNK_HASH_MISMATCH', 4_000);

    const [sql] = runAsync.mock.calls[0]!;
    expect(String(sql).replace(/\s+/g, ' ')).toContain(
      "state IN ('queued', 'transferring', 'verifying', 'paused')",
    );
  });
});
