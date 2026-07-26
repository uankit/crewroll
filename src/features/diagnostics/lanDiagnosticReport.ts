import type { LanDiagnosticsSnapshot } from '@/application/runtime/AirMeshRuntime';

export interface LanDiagnosticReportInput {
  generatedAtMs: number;
  appVersion: string;
  expoSdkVersion: string;
  platform: string;
  platformVersion: string;
  tripId: string;
  readyPeerCount: number;
  diagnostics: LanDiagnosticsSnapshot;
  network: {
    type: string | null;
    isConnected: boolean | null;
    isInternetReachable: boolean | null;
  };
}

/** A deliberately allow-listed report. Invite links, keys and profile data never enter it. */
export function buildRedactedLanDiagnosticReport(input: LanDiagnosticReportInput): string {
  const error = input.diagnostics.lastError;
  const peerIds = input.diagnostics.transportPeerDeviceIds.map(redactIdentifier);
  return [
    'CrewRoll connection diagnostics (redacted)',
    `generatedAt=${safeIso(input.generatedAtMs)}`,
    `app=${sanitizeScalar(input.appVersion)}`,
    `expoSdk=${sanitizeScalar(input.expoSdkVersion)}`,
    `platform=${sanitizeScalar(input.platform)} ${sanitizeScalar(input.platformVersion)}`,
    `trip=${redactIdentifier(input.tripId)}`,
    `admissionRole=${input.diagnostics.role === 'coordinator' ? 'trip-admin' : input.diagnostics.role ?? 'none'}`,
    `transport=${transportKind(input.diagnostics.advertisedEndpoint)}`,
    `advertisedEndpoint=${redactEndpoint(input.diagnostics.advertisedEndpoint)}`,
    `network=${sanitizeScalar(input.network.type ?? 'unknown')}; connected=${formatNullableBoolean(input.network.isConnected)}; internet=${formatNullableBoolean(input.network.isInternetReachable)}`,
    `transportState=${input.diagnostics.transportState}`,
    `reconnectAttempt=${input.diagnostics.reconnectAttempt}`,
    `transportPeers=${peerIds.length}${peerIds.length > 0 ? ` [${peerIds.join(', ')}]` : ''}`,
    `readyTripMembers=${input.readyPeerCount}`,
    `pendingOutbox=${input.diagnostics.pendingOutbox}`,
    `pendingTransfers=${input.diagnostics.pendingTransfers}`,
    error
      ? `lastError=${error.source}/${redactDiagnosticText(error.code)} at ${safeIso(error.atMs)}: ${redactDiagnosticText(error.message)}`
      : 'lastError=none',
  ].join('\n');
}

export function redactEndpoint(value: string | null): string {
  if (!value) return 'none';
  try {
    const url = new URL(value);
    const port = url.port ? `:${url.port}` : '';
    const addressLabel = url.protocol === 'ws:' || url.protocol === 'wss:'
      ? 'relay-address'
      : 'local-address';
    return `${url.protocol}//<${addressLabel}>${port}`;
  } catch {
    return '<redacted-endpoint>';
  }
}

function transportKind(value: string | null): string {
  if (!value) return 'unknown';
  try {
    const protocol = new URL(value).protocol;
    if (protocol === 'ws:' || protocol === 'wss:') return 'relay';
    if (protocol === 'tcp:' || protocol === 'tcp-listen:') return 'lan-fallback';
  } catch {
    // The endpoint itself stays redacted; malformed values are reported only
    // as an unknown transport kind.
  }
  return 'unknown';
}

export function redactIdentifier(value: string): string {
  const safe = sanitizeScalar(value);
  const knownType = safe.match(
    /^(trip|member|device|invite|message|transfer|resource|media)(?:[._:-]|$)/i,
  )?.[1]?.toLowerCase();
  return `<redacted-${knownType ?? 'id'}>`;
}

export function redactDiagnosticText(value: string): string {
  return sanitizeScalar(value)
    .replace(/airmesh:\/\/join\?\S+/gi, '<redacted-invite>')
    .replace(/\b(secret|token|password|authorization|api[-_]?key)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<redacted-id>')
    .replace(/\b[0-9a-f]{32,128}\b/gi, '<redacted-secret>')
    .replace(/\b[A-Za-z0-9+/_-]{43,172}={0,2}\b/g, '<redacted-secret>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip-address>')
    .replace(/\b(?:trip|member|device|invite|message|transfer|resource)[._:-][A-Za-z0-9._:-]{7,127}\b/gi, (id) => redactIdentifier(id));
}

function sanitizeScalar(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').trim().slice(0, 512);
}

function formatNullableBoolean(value: boolean | null): string {
  return value === null ? 'unknown' : String(value);
}

function safeIso(value: number): string {
  const date = new Date(value);
  return Number.isFinite(value) && !Number.isNaN(date.getTime()) ? date.toISOString() : 'invalid';
}
