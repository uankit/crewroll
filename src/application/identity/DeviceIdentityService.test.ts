import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64Url } from '@/application/security/base64url';

import { DeviceIdentityService } from './DeviceIdentityService';
import { InvalidDisplayNameError, normalizeDisplayName } from './profile';

const secureStore = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
});

const crypto = vi.hoisted(() => ({
  getRandomBytesAsync: vi.fn(async (length: number) => new Uint8Array(length).fill(7)),
}));

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock-this-device-only',
  getItemAsync: secureStore.getItemAsync,
  setItemAsync: secureStore.setItemAsync,
}));

vi.mock('expo-crypto', () => ({
  getRandomBytesAsync: crypto.getRandomBytesAsync,
}));

beforeEach(() => {
  secureStore.values.clear();
  secureStore.getItemAsync.mockClear();
  secureStore.setItemAsync.mockClear();
  crypto.getRandomBytesAsync.mockClear();
});

describe('normalizeDisplayName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeDisplayName('  Atri   Singh  ')).toBe('Atri Singh');
  });

  it('accepts non-Latin names', () => {
    expect(normalizeDisplayName('  अंकित  ')).toBe('अंकित');
  });

  it('rejects empty, overlong, and control-character names', () => {
    expect(() => normalizeDisplayName('a')).toThrow(InvalidDisplayNameError);
    expect(() => normalizeDisplayName('x'.repeat(41))).toThrow(InvalidDisplayNameError);
    expect(() => normalizeDisplayName('An\u0000kit')).toThrow(InvalidDisplayNameError);
  });
});

describe('DeviceIdentityService signing cache', () => {
  it('coalesces identity loading and never reads SecureStore on the per-frame signing path', async () => {
    secureStore.values.set('airmesh.identity-secret.v1', encodeBase64Url(new Uint8Array(32).fill(3)));
    const identity = new DeviceIdentityService();

    const [first, second] = await Promise.all([identity.load(), identity.load()]);
    expect(second.identityPublicKey).toBe(first.identityPublicKey);
    expect(secretReadCount()).toBe(1);

    const payload = new Uint8Array([1, 2, 3]);
    const [signatureOne, signatureTwo] = await Promise.all([
      identity.sign(payload),
      identity.sign(payload),
    ]);
    expect(signatureTwo).toBe(signatureOne);
    expect(identity.verify(payload, signatureOne, first.identityPublicKey)).toBe(true);
    expect(secretReadCount()).toBe(1);
  });

  it('still refuses to sign before identity initialization', async () => {
    const identity = new DeviceIdentityService();

    await expect(identity.sign(new Uint8Array([1]))).rejects.toThrow(
      'Device identity has not been initialized',
    );
    expect(secretReadCount()).toBe(0);
  });
});

function secretReadCount(): number {
  return secureStore.getItemAsync.mock.calls.filter(
    ([key]) => key === 'airmesh.identity-secret.v1',
  ).length;
}
