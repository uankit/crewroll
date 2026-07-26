export function storageBackupExclusionTargets(
  platform: string,
  airMeshDocumentsLocation: string,
  sqliteDirectory: unknown,
): string[] {
  if (platform !== 'ios') return [];
  const locations = [
    requireAbsoluteFileLocation(airMeshDocumentsLocation, 'AirMesh documents directory'),
    requireAbsoluteFileLocation(sqliteDirectory, 'SQLite directory'),
  ];
  return [...new Set(locations)];
}

function requireAbsoluteFileLocation(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} is unavailable.`);
  }
  const normalized = value.trim().replace(/\/+$/, '');
  if (!normalized || (!normalized.startsWith('/') && !normalized.startsWith('file://'))) {
    throw new Error(`${label} must be an absolute file path or file:// URI.`);
  }
  return normalized;
}
