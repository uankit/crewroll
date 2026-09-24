import type {
  AccountDeletion,
  AccountPolicy,
  BlockedMembers,
  BlockMemberBody,
  SafetyReportBody,
} from "@crewroll/contracts";

export interface AccountService {
  policy(subject: string): Promise<AccountPolicy>;
  acceptTerms(subject: string): Promise<AccountPolicy>;
  requestDeletion(subject: string): Promise<AccountDeletion>;
  deletionStatus(requestId: string): Promise<AccountDeletion>;
  report(
    subject: string,
    body: SafetyReportBody,
  ): Promise<{ reportId: string }>;
  block(subject: string, body: BlockMemberBody): Promise<void>;
  blockedMembers(subject: string): Promise<BlockedMembers>;
  unblock(subject: string, userId: string): Promise<void>;
  guard(
    subject: string,
    operation: "read" | "write" | "join" | "create" | "register",
  ): Promise<void>;
  cleanup(): Promise<void>;
}

/** Durable provider cleanup checkpoints contain encrypted grants only. */
export interface IdentityDeletionState {
  readonly appleGrant: string | null;
  readonly appleRevoked: boolean;
  checkpoint(grant: string | null, revoked: boolean): Promise<void>;
}
export type DeleteIdentity = (
  subject: string,
  state: IdentityDeletionState,
) => Promise<void>;
