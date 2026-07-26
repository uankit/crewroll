import {
  databaseClient,
  type AirMeshDatabaseClient,
} from './database/client';
import {
  createRepositories,
  type AirMeshRepositories,
  withRepositoriesTransaction,
} from './repositories';

export * from './database';
export * from './repositories';
export * from './types';

export interface AirMeshDataLayer {
  database: AirMeshDatabaseClient;
  repositories: AirMeshRepositories;
  transaction<T>(task: (repositories: AirMeshRepositories) => Promise<T>): Promise<T>;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
export const DELIVERED_OUTBOX_RETENTION_MS = 7 * DAY_MS;
export const TERMINAL_SYNC_HISTORY_RETENTION_MS = 30 * DAY_MS;

export async function applyLocalDataRetention(
  repositories: Pick<AirMeshRepositories, 'outbox' | 'transfers'>,
  nowMs = Date.now(),
): Promise<void> {
  if (!Number.isSafeInteger(nowMs) || nowMs < TERMINAL_SYNC_HISTORY_RETENTION_MS) {
    throw new RangeError('nowMs must be a safe timestamp at least 30 days after epoch.');
  }
  await Promise.all([
    repositories.outbox.removeDeliveredBefore(nowMs - DELIVERED_OUTBOX_RETENTION_MS),
    repositories.outbox.removeDeadLetterBefore(
      nowMs - TERMINAL_SYNC_HISTORY_RETENTION_MS,
    ),
    repositories.transfers.removeTerminalBefore(
      nowMs - TERMINAL_SYNC_HISTORY_RETENTION_MS,
    ),
  ]);
}

/** Initializes SQLite before exposing repositories; initialization errors propagate. */
export async function createDataLayer(
  database: AirMeshDatabaseClient = databaseClient,
): Promise<AirMeshDataLayer> {
  await database.initialize();
  const repositories = createRepositories(database);
  // Retention is best-effort maintenance: a transient delete failure should
  // not prevent a user from opening an otherwise healthy local-first app. The
  // indexed cleanup is retried on the next launch.
  await applyLocalDataRetention(repositories).catch(() => undefined);
  return {
    database,
    repositories,
    transaction: (task) => withRepositoriesTransaction(task, database),
  };
}
