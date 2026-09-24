import { Type, type Static } from "@sinclair/typebox";
import { ClosedObject } from "./common.js";
import { TripIdSchema, UuidSchema } from "./ids.js";

export const ACCOUNT_TERMS_VERSION = "2026-09-24";
export const AccountPolicySchema = ClosedObject({
  termsVersion: Type.String({ maxLength: 32 }),
  accepted: Type.Boolean(),
});
export type AccountPolicy = Static<typeof AccountPolicySchema>;
export const AcceptTermsBodySchema = ClosedObject({
  termsVersion: Type.Literal(ACCOUNT_TERMS_VERSION),
});
export type AcceptTermsBody = Static<typeof AcceptTermsBodySchema>;
export const DeleteAccountBodySchema = ClosedObject({
  confirmation: Type.Literal("DELETE"),
});
export type DeleteAccountBody = Static<typeof DeleteAccountBodySchema>;
export const AccountDeletionSchema = ClosedObject({
  requestId: UuidSchema,
  status: Type.Union([Type.Literal("PENDING"), Type.Literal("COMPLETE")]),
});
export type AccountDeletion = Static<typeof AccountDeletionSchema>;
export const SafetyReportBodySchema = ClosedObject({
  tripId: TripIdSchema,
  membershipId: Type.Optional(UuidSchema),
  assetId: Type.Optional(UuidSchema),
  reason: Type.Union([
    Type.Literal("INAPPROPRIATE"),
    Type.Literal("HARASSMENT"),
    Type.Literal("PRIVACY"),
    Type.Literal("OTHER"),
  ]),
  details: Type.Optional(Type.String({ maxLength: 1000 })),
});
export type SafetyReportBody = Static<typeof SafetyReportBodySchema>;
export const SafetyReportResponseSchema = ClosedObject({
  reportId: UuidSchema,
});
export type SafetyReportResponse = Static<typeof SafetyReportResponseSchema>;
export const BlockMemberBodySchema = ClosedObject({
  tripId: TripIdSchema,
  membershipId: UuidSchema,
});
export type BlockMemberBody = Static<typeof BlockMemberBodySchema>;
export const BlockedMembersSchema = ClosedObject({
  items: Type.Array(
    ClosedObject({
      userId: UuidSchema,
      displayName: Type.String({ maxLength: 80 }),
    }),
    { maxItems: 100 },
  ),
});
export type BlockedMembers = Static<typeof BlockedMembersSchema>;
export const AccountActionResponseSchema = ClosedObject({
  ok: Type.Literal(true),
});
export type AccountActionResponse = Static<typeof AccountActionResponseSchema>;
