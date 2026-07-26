import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const textEncoder = new TextEncoder();

export function createLocalMediaId(deviceId: string, sourceAssetId: string): string {
  if (!deviceId.trim() || !sourceAssetId.trim()) {
    throw new Error('deviceId and sourceAssetId are required.');
  }
  const digest = sha256(textEncoder.encode(`airmesh-media-v1\0${deviceId}\0${sourceAssetId}`));
  return `media_${bytesToHex(digest).slice(0, 32)}`;
}

export function createResourceId(mediaId: string, kind: 'ORIGINAL' | 'THUMBNAIL'): string {
  if (!mediaId.trim()) {
    throw new Error('mediaId is required.');
  }
  const suffix = kind === 'ORIGINAL' ? 'original' : 'thumbnail';
  return `${mediaId}_${suffix}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
