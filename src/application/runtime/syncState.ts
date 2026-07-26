import type { SyncSnapshot } from './AirMeshRuntime';

export function syncStateAfterTransportError(
  current: SyncSnapshot['state'],
  recoverable: boolean,
): SyncSnapshot['state'] {
  return recoverable ? current : 'error';
}
