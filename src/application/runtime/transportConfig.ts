export type RuntimeTransportConfig =
  | { readonly mode: 'relay'; readonly relayUrl: string }
  | { readonly mode: 'lan' };

export interface RuntimeTransportEnvironment {
  readonly mode?: string;
  readonly relayUrl?: string;
  readonly allowInsecureRelay?: string;
}

/**
 * Expo 57 statically substitutes EXPO_PUBLIC values only when referenced with
 * dot notation. Keep these references explicit; none of these values is a
 * secret because every EXPO_PUBLIC value is embedded in the application.
 */
export function readRuntimeTransportConfig(): RuntimeTransportConfig {
  return resolveRuntimeTransportConfig({
    mode: process.env.EXPO_PUBLIC_AIRMESH_TRANSPORT,
    relayUrl: process.env.EXPO_PUBLIC_AIRMESH_RELAY_URL,
    allowInsecureRelay: process.env.EXPO_PUBLIC_AIRMESH_ALLOW_INSECURE_RELAY,
  });
}

export function resolveRuntimeTransportConfig(
  environment: RuntimeTransportEnvironment,
): RuntimeTransportConfig {
  const mode = environment.mode?.trim().toLowerCase() || 'relay';
  if (mode === 'lan') return { mode: 'lan' };
  if (mode !== 'relay') {
    throw new Error('EXPO_PUBLIC_AIRMESH_TRANSPORT must be either "relay" or "lan".');
  }

  const value = environment.relayUrl?.trim();
  if (!value) {
    throw new Error(
      'Relay mode requires EXPO_PUBLIC_AIRMESH_RELAY_URL. Set it to the public WSS relay endpoint, or explicitly select LAN mode.',
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('EXPO_PUBLIC_AIRMESH_RELAY_URL must be a valid ws:// or wss:// URL.');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('EXPO_PUBLIC_AIRMESH_RELAY_URL must use ws:// or wss://.');
  }
  if (!url.hostname || url.username || url.password || url.hash) {
    throw new Error('EXPO_PUBLIC_AIRMESH_RELAY_URL contains unsupported URL components.');
  }
  if (
    url.protocol === 'ws:' &&
    environment.allowInsecureRelay?.trim().toLowerCase() !== 'true'
  ) {
    throw new Error(
      'Plain ws:// relay traffic is disabled. Use wss:// or explicitly set EXPO_PUBLIC_AIRMESH_ALLOW_INSECURE_RELAY=true for local development.',
    );
  }

  // The client owns the routing key so it cannot be accidentally pinned to a
  // stale trip by build configuration.
  url.searchParams.delete('room');
  return { mode: 'relay', relayUrl: url.toString() };
}
