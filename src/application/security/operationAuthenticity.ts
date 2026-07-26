import { parseSyncOperation, type SyncOperation } from '@/core/domain';
import { assertParsed } from '@/core/validation';

import type { FrameIdentityAuthenticator } from './frameAuthenticity';

const textEncoder = new TextEncoder();

export type AuthenticatedSyncOperation = SyncOperation & {
  readonly originIdentityPublicKey: NonNullable<SyncOperation['originIdentityPublicKey']>;
  readonly originSignature: string;
};

export async function signSyncOperation<T extends SyncOperation>(
  operation: T,
  originIdentityPublicKey: string,
  identity: Pick<FrameIdentityAuthenticator, 'sign'>,
): Promise<T & AuthenticatedSyncOperation> {
  const canonicalOperation = assertParsed(parseSyncOperation(operation));
  const signature = await identity.sign(
    syncOperationSigningBytes(canonicalOperation, originIdentityPublicKey),
  );
  return assertParsed(
    parseSyncOperation({
      ...canonicalOperation,
      originIdentityPublicKey,
      originSignature: signature,
    }),
  ) as T & AuthenticatedSyncOperation;
}

export function verifySyncOperation(
  operation: SyncOperation,
  identity: Pick<FrameIdentityAuthenticator, 'verify'>,
  expectedIdentityPublicKey?: string,
): operation is AuthenticatedSyncOperation {
  const publicKey = operation.originIdentityPublicKey;
  const signature = operation.originSignature;
  if (!publicKey || !signature) return false;
  if (expectedIdentityPublicKey !== undefined && publicKey !== expectedIdentityPublicKey) {
    return false;
  }
  return identity.verify(
    syncOperationSigningBytes(operation, publicKey),
    signature,
    publicKey,
  );
}

export function syncOperationSigningBytes(
  operation: SyncOperation,
  originIdentityPublicKey: string,
): Uint8Array {
  const {
    originIdentityPublicKey: _storedPublicKey,
    originSignature: _storedSignature,
    ...unsignedOperation
  } = operation;
  return textEncoder.encode(
    canonicalJson([
      'airmesh-sync-operation-signature-v1',
      originIdentityPublicKey,
      unsignedOperation,
    ]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = canonicalValue(child);
    }
    return output;
  }
  return value;
}
