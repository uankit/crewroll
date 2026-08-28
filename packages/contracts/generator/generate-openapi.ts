import { writeFile } from "node:fs/promises";

import { createOpenApiDocument, serializeOpenApiDocument } from "./openapi.js";

const destination = new URL("../generated/crewroll.openapi.json", import.meta.url);
await writeFile(destination, serializeOpenApiDocument(createOpenApiDocument()), "utf8");
