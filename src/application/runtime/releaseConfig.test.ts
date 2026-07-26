import { describe, expect, it } from 'vitest';

import appConfig from '../../../app.json';
import packageConfig from '../../../package.json';
import { PROTOCOL_VERSION } from '../../core/constants';

describe('native release configuration', () => {
  it('keeps the native runtime, wire protocol, and package release aligned', () => {
    expect(appConfig.expo.version).toBe(packageConfig.version);
    expect(appConfig.expo.runtimeVersion).toEqual({ policy: 'appVersion' });
    expect(appConfig.expo.extra.airmesh.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('prevents private replicas and keys from entering Android backups', () => {
    expect(appConfig.expo.android.allowBackup).toBe(false);
    const secureStorePlugin = appConfig.expo.plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-secure-store',
    );
    expect(secureStorePlugin).toEqual([
      'expo-secure-store',
      expect.objectContaining({ configureAndroidBackup: false }),
    ]);
  });
});
