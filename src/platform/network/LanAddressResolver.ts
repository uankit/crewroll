import * as Network from 'expo-network';

export interface LanAddressSources {
  getPrimaryAddress(): Promise<string>;
  getInterfaceAddresses(): Promise<readonly string[]>;
}

const nativeSources: LanAddressSources = {
  getPrimaryAddress: Network.getIpAddressAsync,
  getInterfaceAddresses: async () => {
    const { default: AirMeshLan } = await import('../../../modules/airmesh-lan');
    return AirMeshLan.getIPv4AddressesAsync();
  },
};

/**
 * Returns a stable, directly routable IPv4 address for a coordinator invite.
 * Expo's main-interface address remains preferred on ordinary Wi-Fi. Native
 * enumeration fills the Android hotspot-host gap where WifiManager reports
 * 0.0.0.0. Interface names are deliberately not assumed on either platform.
 */
export async function resolveCoordinatorLanAddress(
  sources: LanAddressSources = nativeSources,
): Promise<string> {
  const [primaryResult, interfacesResult] = await Promise.allSettled([
    sources.getPrimaryAddress(),
    sources.getInterfaceAddresses(),
  ]);
  const primary = primaryResult.status === 'fulfilled' ? primaryResult.value : null;
  const interfaces = interfacesResult.status === 'fulfilled' ? interfacesResult.value : [];
  const selected = selectAdvertisableAddress(primary, interfaces);
  if (!selected) {
    throw new Error(
      'No reachable LAN address is available. Connect to Wi-Fi or enable this phone’s personal hotspot, then try again.',
    );
  }
  return selected;
}

export function selectAdvertisableAddress(
  primary: string | null | undefined,
  interfaceAddresses: readonly string[],
): string | null {
  const candidates = [primary, ...interfaceAddresses]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(isAdvertisableIPv4);
  return [...new Set(candidates)].sort(compareAddresses)[0] ?? null;
}

export function isAdvertisableIPv4(value: string): boolean {
  const octets = parseIPv4(value);
  if (!octets) return false;
  const [a, b] = octets;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function compareAddresses(left: string, right: string): number {
  // The primary source is inserted first and stable sorting keeps it ahead of
  // an equivalent-rank native fallback. RFC1918 is preferred to link-local.
  const leftRank = left.startsWith('169.254.') ? 1 : 0;
  const rightRank = right.startsWith('169.254.') ? 1 : 0;
  return leftRank - rightRank;
}

function parseIPv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : -1));
  if (octets.some((part) => part < 0 || part > 255)) return null;
  return octets as [number, number, number, number];
}
