export interface ClerkWebhookHeaders {
  readonly svixId: string | undefined;
  readonly svixSignature: string | undefined;
  readonly svixTimestamp: string | undefined;
}

export interface VerifiedClerkWebhookEvent {
  readonly clerkSubject: string | null;
  readonly displayName: string | null;
  readonly eventId: string;
  readonly eventType: string;
}

export interface ClerkWebhookVerifier {
  verify(
    rawBody: Readonly<Uint8Array>,
    headers: ClerkWebhookHeaders,
  ): Promise<VerifiedClerkWebhookEvent>;
}
