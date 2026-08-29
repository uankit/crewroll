import * as Crypto from "expo-crypto";

import type { RandomBytesPort } from "../../domain/ids/random";

export class ExpoRandomBytesPort implements RandomBytesPort {
  async getBytes(count: number): Promise<Uint8Array> {
    return Crypto.getRandomBytesAsync(count);
  }
}
