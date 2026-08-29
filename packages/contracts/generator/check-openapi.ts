import { readFile } from "node:fs/promises";

import { createOpenApiDocument, serializeOpenApiDocument } from "./openapi.js";

const destination = new URL(
  "../generated/crewroll.openapi.json",
  import.meta.url,
);
const expected = serializeOpenApiDocument(createOpenApiDocument());
const actual = await readFile(destination, "utf8");

if (actual !== expected) {
  console.error(
    "Generated OpenAPI artifact is stale. Run npm run openapi:generate -w @crewroll/contracts.",
  );
  process.exitCode = 1;
}
