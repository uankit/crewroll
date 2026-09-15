/** Development-only transport. Production uses signed object-storage URLs. */
export interface LocalCiphertextGateway {
  put(
    token: string,
    body: AsyncIterable<Uint8Array>,
  ): Promise<{ etag: string }>;
  get(
    token: string,
  ): Promise<{ body: AsyncIterable<Uint8Array>; bytes: number; etag: string }>;
}
