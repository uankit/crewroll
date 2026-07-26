import { describe, expect, it } from 'vitest';

import { storageBackupExclusionTargets } from './backupExclusionPolicy';

describe('storageBackupExclusionTargets', () => {
  it('covers both durable photo replicas and the Expo SQLite directory on iOS', () => {
    expect(storageBackupExclusionTargets(
      'ios',
      'file:///var/mobile/app/Documents/airmesh/',
      '/var/mobile/app/Documents/SQLite/',
    )).toEqual([
      'file:///var/mobile/app/Documents/airmesh',
      '/var/mobile/app/Documents/SQLite',
    ]);
  });

  it('does not invoke the iOS policy on other platforms', () => {
    expect(storageBackupExclusionTargets('android', '', null)).toEqual([]);
  });

  it('fails closed if an iOS storage root is not an absolute local location', () => {
    expect(() => storageBackupExclusionTargets(
      'ios',
      'https://example.test/not-local',
      '/var/mobile/app/Documents/SQLite',
    )).toThrow(/absolute file path/i);
  });
});
