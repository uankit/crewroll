import { DeviceIdentityService } from '@/application/identity/DeviceIdentityService';
import { TransferBenchmarkRecorder } from '@/application/diagnostics/TransferBenchmarkRecorder';
import { MediaIngestionService } from '@/application/media/MediaIngestionService';
import { AirMeshRuntime, type SyncDriver } from '@/application/runtime/AirMeshRuntime';
import { LocalSyncDriver } from '@/application/runtime/LocalSyncDriver';
import { readRuntimeTransportConfig } from '@/application/runtime/transportConfig';
import { PersistentSequenceAllocator } from '@/application/sequences/PersistentSequenceAllocator';
import { SecureStoreTripKeyVault } from '@/application/security/TripKeyVault';
import { TripLifecycleService } from '@/application/trips/TripLifecycleService';
import { createDataLayer } from '@/data';
import { ExpoFileStore } from '@/platform/files';
import { ExpoMediaGateway } from '@/platform/media';
import { enforceIosStorageBackupExclusion } from '@/platform/storage';
import {
  MobileTcpTransport,
  WebSocketRelayTransport,
  createRelayAuthenticator,
} from '@/platform/transport';

export async function createAirMeshRuntime(sync?: SyncDriver): Promise<AirMeshRuntime> {
  const transportConfig = readRuntimeTransportConfig();
  const data = await createDataLayer();
  try {
    await enforceIosStorageBackupExclusion();
  } catch (error) {
    try {
      await data.database.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Local storage backup policy failed and the database could not be closed.',
      );
    }
    throw error;
  }
  const identity = new DeviceIdentityService();
  const transferBenchmarks = new TransferBenchmarkRecorder(data);
  const keys = new SecureStoreTripKeyVault();
  const mediaGateway = new ExpoMediaGateway();
  const fileStore = new ExpoFileStore();
  const mediaSequence = new PersistentSequenceAllocator(data, 'media');
  const operationSequence = new PersistentSequenceAllocator(data, 'operation');
  const media = new MediaIngestionService({
    persistence: data,
    mediaGateway,
    fileStore,
    mediaSequenceAllocator: mediaSequence,
    operationSequenceAllocator: operationSequence,
    identity,
  });
  const trips = new TripLifecycleService({
    data,
    identity,
    keys,
    endpoint: transportConfig.mode === 'relay'
      ? async () => transportConfig.relayUrl
      : undefined,
  });

  return new AirMeshRuntime({
    data,
    identity,
    trips,
    media,
    mediaGateway,
    transferBenchmarks,
    sync: sync ?? new LocalSyncDriver({
      data,
      identity,
      fileStore,
      keys,
      transferBenchmarks,
      transportFactory: ({ groupSecret }) =>
        transportConfig.mode === 'relay'
          ? new WebSocketRelayTransport({
              authentication: createRelayAuthenticator(groupSecret, identity),
            })
          : new MobileTcpTransport(),
      transportEndpoint: (session) =>
        transportConfig.mode === 'relay'
          ? transportConfig.relayUrl
          : lanTransportEndpoint(session.endpoint, session.isCoordinator),
    }),
  });
}

function lanTransportEndpoint(endpointValue: string, isCoordinator: boolean): string {
  if (!isCoordinator) return endpointValue;
  const endpoint = new URL(endpointValue);
  if (endpoint.protocol !== 'tcp:' || !endpoint.port) {
    throw new Error('LAN coordinator endpoint must be a TCP address with a port.');
  }
  return `tcp-listen://0.0.0.0:${endpoint.port}`;
}
