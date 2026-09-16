import { Type, type Static } from "@sinclair/typebox";
import { ClosedObject } from "./common.js";

// Names are read from the authenticated Clerk account, never a caller-supplied user ID.
export const SyncProfileBodySchema = ClosedObject({});
export type SyncProfileBody = Static<typeof SyncProfileBodySchema>;
export const ProfileResponseSchema = ClosedObject({
  displayName: Type.String({ minLength: 1, maxLength: 80 }),
});
export type ProfileResponse = Static<typeof ProfileResponseSchema>;
