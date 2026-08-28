export type PresignedPut = Readonly<{
  url: string;
  requiredHeaders: Readonly<Record<string, string>>;
}>;

export interface ApiMediaObjectStore {
  createPutUrl(input: Readonly<{
    key: string;
    bytes: bigint;
    checksumSha256Base64: string;
    expiresAt: Date;
  }>): Promise<PresignedPut>;
  head(input: Readonly<{ key: string }>): Promise<Readonly<{
    exists: boolean;
    bytes?: bigint;
    checksumSha256Base64?: string;
    etag?: string;
  }>>;
  createGetUrl(input: Readonly<{ key: string; expiresAt: Date }>): Promise<string>;
}

export interface WorkerMediaObjectDeletionStore {
  deleteObjects(input: Readonly<{ keys: readonly string[] }>): Promise<void>;
}
