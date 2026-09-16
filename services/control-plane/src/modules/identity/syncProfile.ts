import type { ProfileResponse } from "@crewroll/contracts";
import type { Clock } from "../../shared/time/clock.js";
import type { IdGenerator } from "../../shared/ids/idGenerator.js";
import { DomainError } from "../../shared/errors/domainError.js";
import type { ProfileRepository } from "./ports/profileRepository.js";

export interface SyncProfileDependencies {
  readonly directory: {
    getUser(clerkSubject: string): Promise<{
      readonly clerkSubject: string;
      readonly displayName: string;
    }>;
  };
  readonly repository: ProfileRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Idempotent refresh from the identity provider; never creates device credentials. */
export function createSyncProfile(dependencies: SyncProfileDependencies) {
  return {
    async execute(clerkSubject: string): Promise<ProfileResponse> {
      const profile = await dependencies.directory.getUser(clerkSubject);
      if (profile.clerkSubject !== clerkSubject)
        throw new DomainError("AUTH_INVALID");
      await dependencies.repository.synchronizeProfile(
        clerkSubject,
        profile.displayName,
        dependencies.ids.uuid(),
        dependencies.clock.now(),
      );
      return { displayName: profile.displayName };
    },
  };
}
