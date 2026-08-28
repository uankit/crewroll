import { Type, type Static } from "@sinclair/typebox";

import { ClosedObject, UriSchema } from "./common.js";
import { ProblemCodeSchema } from "./errors.js";
import { UuidSchema } from "./ids.js";

export const ProblemDetailsSchema = ClosedObject({
  type: UriSchema,
  title: Type.String({ minLength: 1, maxLength: 160 }),
  status: Type.Integer({ minimum: 400, maximum: 599 }),
  detail: Type.String({ minLength: 1, maxLength: 2048 }),
  instance: Type.String({ pattern: "^(?:https?://|/)[^\\s]+$" }),
  code: ProblemCodeSchema,
  requestId: UuidSchema,
});
export type ProblemDetails = Static<typeof ProblemDetailsSchema>;
