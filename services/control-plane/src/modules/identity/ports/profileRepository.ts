export interface ProfileRepository {
  synchronizeProfile(
    clerkSubject: string,
    displayName: string,
    candidateUserId: string,
    now: Date,
  ): Promise<void>;
}
