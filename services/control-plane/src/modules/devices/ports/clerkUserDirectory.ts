export interface ClerkUserProjection {
  readonly clerkSubject: string;
  readonly displayName: string;
}

export interface ClerkUserDirectory {
  getUser(clerkSubject: string): Promise<ClerkUserProjection>;
}
