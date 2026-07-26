import { describe, expect, it, vi } from 'vitest';

import {
  isAdvertisableIPv4,
  resolveCoordinatorLanAddress,
  selectAdvertisableAddress,
} from './LanAddressResolver';

vi.mock('expo-network', () => ({ getIpAddressAsync: async () => '192.168.1.10' }));

describe('LAN coordinator address selection', () => {
  it('prefers Expo Network’s usable main address on ordinary Wi-Fi', () => {
    expect(
      selectAdvertisableAddress('192.168.1.23', ['172.20.10.1', '192.168.1.23']),
    ).toBe('192.168.1.23');
  });

  it('falls back to native interface enumeration for an Android hotspot host', () => {
    expect(selectAdvertisableAddress('0.0.0.0', ['192.168.43.1'])).toBe('192.168.43.1');
  });

  it('rejects loopback, unspecified, public, malformed, and IPv6 addresses', () => {
    for (const address of ['127.0.0.1', '0.0.0.0', '8.8.8.8', '192.168.1.999', 'fe80::1']) {
      expect(isAdvertisableIPv4(address)).toBe(false);
    }
  });

  it('fails with actionable guidance when neither source has a LAN address', async () => {
    await expect(
      resolveCoordinatorLanAddress({
        getPrimaryAddress: async () => '0.0.0.0',
        getInterfaceAddresses: async () => [],
      }),
    ).rejects.toThrow(/Wi-Fi|hotspot/i);
  });
});
