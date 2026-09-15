import { FormatRegistry, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// Exercise real package initialization and the registry shared across entrypoints.
FormatRegistry.Set("crewroll-startup-probe", (value) => value === "ready");
const schema = Type.Object({
  status: Type.String({ format: "crewroll-startup-probe" }),
});

export const acceptsValid = Value.Check(schema, { status: "ready" });
export const rejectsInvalid = !Value.Check(schema, { status: "invalid" });
