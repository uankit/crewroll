import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { ChunkedFileStore } from '@/platform/files';

export interface FileDigest {
  sha256: string;
  byteLength: number;
}

export async function hashFile(
  fileStore: ChunkedFileStore,
  uri: string,
  chunkSize = 1024 * 1024,
): Promise<FileDigest> {
  const hasher = sha256.create();
  let byteLength = 0;

  for await (const chunk of fileStore.readChunks({ uri, chunkSize })) {
    if (chunk.offset !== byteLength) {
      throw new Error(`Non-contiguous file read: expected offset ${byteLength}, got ${chunk.offset}.`);
    }
    hasher.update(chunk.bytes);
    byteLength += chunk.bytes.byteLength;
  }

  return { sha256: bytesToHex(hasher.digest()), byteLength };
}
