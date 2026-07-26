import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODE_VARIABLE = 'EXPO_PUBLIC_AIRMESH_TRANSPORT';
const URL_VARIABLE = 'EXPO_PUBLIC_AIRMESH_RELAY_URL';
const RESERVED_DOMAIN_SUFFIXES = [
  '.alt',
  '.arpa',
  '.example',
  '.invalid',
  '.internal',
  '.lan',
  '.local',
  '.localhost',
  '.onion',
  '.test',
];
const RESERVED_EXAMPLE_DOMAINS = ['example.com', 'example.net', 'example.org'];

/**
 * Validate only static release coordinates. This deliberately performs no DNS
 * lookup or network request, so it is safe before dependencies are installed
 * and does not turn a transient relay outage into a build failure.
 */
export function validateReleaseEnvironment(environment) {
  const mode = environment[MODE_VARIABLE]?.trim().toLowerCase();
  if (mode !== 'relay') {
    throw new Error(`${MODE_VARIABLE} must be set to "relay" for an EAS build.`);
  }

  const rawRelayUrl = environment[URL_VARIABLE]?.trim();
  if (!rawRelayUrl) {
    throw new Error(`${URL_VARIABLE} must be set to the deployed public WSS relay.`);
  }

  let relayUrl;
  try {
    relayUrl = new URL(rawRelayUrl);
  } catch {
    throw new Error(`${URL_VARIABLE} must be a valid URL.`);
  }

  if (relayUrl.protocol !== 'wss:') {
    throw new Error(`${URL_VARIABLE} must use wss://.`);
  }
  if (relayUrl.username || relayUrl.password) {
    throw new Error(`${URL_VARIABLE} must not contain credentials.`);
  }
  if (relayUrl.hash) {
    throw new Error(`${URL_VARIABLE} must not contain a URL fragment.`);
  }
  if (relayUrl.port === '0') {
    throw new Error(`${URL_VARIABLE} must not use port 0.`);
  }
  for (const key of relayUrl.searchParams.keys()) {
    if (key.toLowerCase() === 'room') {
      throw new Error(`${URL_VARIABLE} must not pin a room query parameter.`);
    }
  }

  assertPublicHostname(relayUrl.hostname);
  return { mode: 'relay', relayUrl: relayUrl.toString() };
}

function assertPublicHostname(rawHostname) {
  if (!rawHostname) {
    throw new Error(`${URL_VARIABLE} must contain a hostname.`);
  }

  const hostname = stripIpv6Brackets(rawHostname).toLowerCase();
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    if (!isPublicIpv4(hostname)) {
      throw new Error(`${URL_VARIABLE} must not use a private, local, or reserved IP address.`);
    }
    return;
  }
  if (ipVersion === 6) {
    if (!isPublicIpv6(hostname)) {
      throw new Error(`${URL_VARIABLE} must not use a private, local, or reserved IP address.`);
    }
    return;
  }

  if (hostname.endsWith('.')) {
    throw new Error(`${URL_VARIABLE} must use a canonical hostname without a trailing dot.`);
  }
  if (!hostname.includes('.')) {
    throw new Error(`${URL_VARIABLE} must use a public fully-qualified hostname.`);
  }
  if (hostname.length > 253 || !hostname.split('.').every(isValidDomainLabel)) {
    throw new Error(`${URL_VARIABLE} contains an invalid hostname.`);
  }
  if (
    RESERVED_DOMAIN_SUFFIXES.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    ) ||
    RESERVED_EXAMPLE_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    )
  ) {
    throw new Error(`${URL_VARIABLE} must not use a placeholder or local hostname.`);
  }
}

function isValidDomainLabel(label) {
  return (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}

function stripIpv6Brackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isPublicIpv4(hostname) {
  const octets = hostname.split('.').map(Number);
  const [a, b, c] = octets;
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return false;

  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicIpv6(hostname) {
  const words = parseIpv6Words(hostname);
  if (!words) return false;

  // IPv4-mapped addresses must be classified using the embedded IPv4 value.
  if (
    words.slice(0, 5).every((word) => word === 0) &&
    words[5] === 0xffff
  ) {
    const ipv4 = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
    return isPublicIpv4(ipv4);
  }

  // Accept only global-unicast space and exclude the documentation prefix.
  return (
    (words[0] & 0xe000) === 0x2000 &&
    !(words[0] === 0x2001 && words[1] === 0x0db8)
  );
}

function parseIpv6Words(hostname) {
  const halves = hostname.split('::');
  if (halves.length > 2) return null;

  const left = parseIpv6Half(halves[0]);
  const right = halves.length === 2 ? parseIpv6Half(halves[1]) : [];
  if (!left || !right) return null;

  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Half(value) {
  if (!value) return [];
  const parts = value.split(':');
  const words = [];

  for (const [index, part] of parts.entries()) {
    if (part.includes('.')) {
      if (index !== parts.length - 1 || isIP(part) !== 4) return null;
      const octets = part.split('.').map(Number);
      words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    validateReleaseEnvironment(process.env);
    process.stdout.write('Release relay environment is valid.\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Release environment is invalid.';
    process.stderr.write(`Release environment validation failed: ${message}\n`);
    process.exitCode = 1;
  }
}
