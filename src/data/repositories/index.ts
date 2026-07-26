import type { SQLiteDatabase } from 'expo-sqlite';

import {
  databaseClient,
  type AirMeshDatabaseClient,
} from '../database/client';
import type {
  DeviceSettingsRepository,
  GalleryRepository,
  MediaRepository,
  MemberRepository,
  OutboxRepository,
  ReplicaReceiptRepository,
  ResourceRepository,
  SyncOperationRepository,
  TransferRepository,
  TripRepository,
} from './contracts';
import { SqliteDeviceSettingsRepository } from './deviceSettings';
import { SqliteGalleryRepository } from './gallery';
import { SqliteMediaRepository } from './media';
import { SqliteMemberRepository } from './members';
import { SqliteOutboxRepository } from './outbox';
import { SqliteReplicaReceiptRepository } from './replicaReceipts';
import { SqliteResourceRepository } from './resources';
import { SqliteSyncOperationRepository } from './syncOperations';
import { SqliteTransferRepository } from './transfers';
import { SqliteTripRepository } from './trips';

export * from './contracts';
export * from './deviceSettings';
export * from './gallery';
export * from './media';
export * from './members';
export * from './outbox';
export * from './replicaReceipts';
export * from './resources';
export * from './syncOperations';
export * from './transfers';
export * from './trips';

export interface AirMeshRepositories {
  trips: TripRepository;
  members: MemberRepository;
  media: MediaRepository;
  gallery: GalleryRepository;
  resources: ResourceRepository;
  replicaReceipts: ReplicaReceiptRepository;
  syncOperations: SyncOperationRepository;
  outbox: OutboxRepository;
  transfers: TransferRepository;
  deviceSettings: DeviceSettingsRepository;
}

export function createRepositories(
  client: AirMeshDatabaseClient = databaseClient,
): AirMeshRepositories {
  return {
    trips: new SqliteTripRepository(client),
    members: new SqliteMemberRepository(client),
    media: new SqliteMediaRepository(client),
    gallery: new SqliteGalleryRepository(client),
    resources: new SqliteResourceRepository(client),
    replicaReceipts: new SqliteReplicaReceiptRepository(client),
    syncOperations: new SqliteSyncOperationRepository(client),
    outbox: new SqliteOutboxRepository(client),
    transfers: new SqliteTransferRepository(client),
    deviceSettings: new SqliteDeviceSettingsRepository(client),
  };
}

function createTransactionBoundClient(database: SQLiteDatabase): AirMeshDatabaseClient {
  return {
    initialize: async () => undefined,
    connection: async () => database,
    // Repository methods that require an internal transaction reuse the outer
    // aggregate transaction. The outer client owns commit/rollback.
    transaction: async <T>(task: (connection: SQLiteDatabase) => Promise<T>) => task(database),
    close: async () => {
      throw new Error('A transaction-bound database connection cannot be closed directly.');
    },
  };
}

/** Runs a multi-repository application action in one BEGIN IMMEDIATE transaction. */
export function withRepositoriesTransaction<T>(
  task: (repositories: AirMeshRepositories) => Promise<T>,
  client: AirMeshDatabaseClient = databaseClient,
): Promise<T> {
  return client.transaction((database) =>
    task(createRepositories(createTransactionBoundClient(database))),
  );
}
