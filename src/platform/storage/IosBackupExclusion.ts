import { Directory, Paths } from 'expo-file-system';
import { defaultDatabaseDirectory } from 'expo-sqlite';
import { Platform } from 'react-native';

import { storageBackupExclusionTargets } from './backupExclusionPolicy';

const AIRMESH_DOCUMENT_DIRECTORY = 'airmesh';

/**
 * Excludes device-local replicas and sync metadata from iOS device/iCloud
 * backup. This runs on every launch because Apple documents that file
 * operations can reset the resource property.
 */
export async function enforceIosStorageBackupExclusion(): Promise<void> {
  if (Platform.OS !== 'ios') return;

  const airMeshDocuments = new Directory(Paths.document, AIRMESH_DOCUMENT_DIRECTORY);
  airMeshDocuments.create({ idempotent: true, intermediates: true });
  const targets = storageBackupExclusionTargets(
    Platform.OS,
    airMeshDocuments.uri,
    defaultDatabaseDirectory,
  );
  const { default: native } = await import('../../../modules/airmesh-lan');
  await native.excludeFromBackupAsync(targets);
}
