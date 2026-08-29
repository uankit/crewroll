export interface BackgroundCredentialInput {
  readonly deviceId: string;
  readonly expiresAt: Date;
  readonly userId: string;
}

export interface IssuedBackgroundCredential {
  readonly bearer: string;
  readonly bearerHash: Readonly<Uint8Array>;
}

export interface BackgroundCredentialIssuer {
  issue(input: BackgroundCredentialInput): IssuedBackgroundCredential;
}
