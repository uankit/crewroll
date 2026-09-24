import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

export const requiredOperations = [
  "getAccountPolicy",
  "acceptAccountTerms",
  "requestAccountDeletion",
  "reportSafetyIssue",
  "getBlockedMembers",
  "blockMember",
  "unblockMember",
  "getTripContinuity",
  "changeTripContinuity",
  "listTrips",
  "getTripLifecycle",
  "changeTripLifecycle",
  "approveJoinRequest",
  "rejectJoinRequest",
  "createJoinRequest",
  "createTrip",
  "getTrip",
  "previewInvite",
  "registerDevice",
  "resolveCreateTripOutcome",
  "setTripReadiness",
  "startTrip",
  "syncProfile",
];

const UUID_SCHEMA = Object.freeze({ type: "string", format: "uuid" });
const UUID_V7_SCHEMA = Object.freeze({
  format: "uuid",
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  type: "string",
});
const PROBLEM_STATUSES = ["400", "401", "403", "404", "409", "429", "500"];
const HTTP_METHODS = [
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
];
// Canonical-key SHA-256 after adding authenticated envelope sender identity for device recovery.
const ACCEPTED_TRIP_RESPONSE_SCHEMA_SHA256 =
  "e6374d8f60fa6f84529e949dc58e889d620fa38b81b5506b06bcc96fea345f8d";
const CLERK_BEARER_SCHEME = Object.freeze({
  type: "http",
  scheme: "bearer",
  bearerFormat: "Clerk",
});

function parameter(name, location, schema) {
  return { name, in: location, required: true, schema };
}

const deviceHeader = () =>
  parameter("X-CrewRoll-Device-Id", "header", UUID_SCHEMA);
const commandHeader = () => parameter("Idempotency-Key", "header", UUID_SCHEMA);
const tripPath = () => parameter("tripId", "path", UUID_V7_SCHEMA);
const membershipPath = () => parameter("membershipId", "path", UUID_SCHEMA);

const operationExpectations = [
  {
    method: "get",
    operationId: "getAccountPolicy",
    parameters: [],
    path: "/v1/account",
    request: null,
    response: "AccountPolicy",
    successStatus: "200",
  },
  {
    method: "put",
    operationId: "acceptAccountTerms",
    parameters: [],
    path: "/v1/account/terms",
    request: "AcceptTermsBody",
    response: "AccountPolicy",
    successStatus: "200",
  },
  {
    method: "post",
    operationId: "requestAccountDeletion",
    parameters: [],
    path: "/v1/account/deletion",
    request: "DeleteAccountBody",
    response: "AccountDeletion",
    successStatus: "202",
  },
  {
    method: "post",
    operationId: "reportSafetyIssue",
    parameters: [],
    path: "/v1/account/reports",
    request: "SafetyReportBody",
    response: "SafetyReportResponse",
    successStatus: "201",
  },
  {
    method: "get",
    operationId: "getBlockedMembers",
    parameters: [],
    path: "/v1/account/blocks",
    request: null,
    response: "BlockedMembers",
    successStatus: "200",
  },
  {
    method: "post",
    operationId: "blockMember",
    parameters: [],
    path: "/v1/account/blocks",
    request: "BlockMemberBody",
    response: "AccountActionResponse",
    successStatus: "200",
  },
  {
    method: "delete",
    operationId: "unblockMember",
    parameters: [parameter("userId", "path", UUID_SCHEMA)],
    path: "/v1/account/blocks/{userId}",
    request: null,
    response: "AccountActionResponse",
    successStatus: "200",
  },
  {
    method: "get",
    operationId: "getTripContinuity",
    parameters: [deviceHeader(), tripPath()],
    path: "/v1/trips/{tripId}/continuity",
    request: null,
    response: "TripContinuity",
    successStatus: "200",
  },
  {
    method: "post",
    operationId: "changeTripContinuity",
    parameters: [deviceHeader(), commandHeader(), tripPath()],
    path: "/v1/trips/{tripId}/continuity",
    request: "TripContinuityBody",
    response: "TripContinuity",
    successStatus: "200",
  },
  {
    method: "get",
    operationId: "listTrips",
    parameters: [deviceHeader()],
    path: "/v1/trips",
    request: null,
    response: "TripListResponse",
    successStatus: "200",
  },
  {
    method: "get",
    operationId: "getTripLifecycle",
    parameters: [deviceHeader(), tripPath()],
    path: "/v1/trips/{tripId}/lifecycle",
    request: null,
    response: "TripTransferState",
    successStatus: "200",
  },
  {
    method: "post",
    operationId: "changeTripLifecycle",
    parameters: [deviceHeader(), commandHeader(), tripPath()],
    path: "/v1/trips/{tripId}/lifecycle",
    request: "TripLifecycleBody",
    response: "TripTransferState",
    successStatus: "200",
  },
  {
    method: "put",
    operationId: "syncProfile",
    parameters: [],
    path: "/v1/profile",
    request: "SyncProfileBody",
    response: "ProfileResponse",
    successStatus: "200",
  },
  {
    method: "post",
    operationId: "previewInvite",
    parameters: [deviceHeader()],
    path: "/v1/trips/invite-preview",
    request: "InvitePreviewBody",
    response: "InvitePreviewResponse",
    successStatus: "200",
  },
  {
    method: "put",
    operationId: "approveJoinRequest",
    parameters: [deviceHeader(), commandHeader(), tripPath(), membershipPath()],
    path: "/v1/trips/{tripId}/join-requests/{membershipId}/approval",
    request: "ApproveJoinRequestBody",
    response: "MembershipResponse",
    successStatus: "200",
  },
  {
    method: "delete",
    operationId: "rejectJoinRequest",
    parameters: [deviceHeader(), commandHeader(), tripPath(), membershipPath()],
    path: "/v1/trips/{tripId}/join-requests/{membershipId}",
    request: null,
    response: null,
    successStatus: "204",
  },
  {
    method: "post",
    operationId: "createJoinRequest",
    parameters: [deviceHeader(), commandHeader()],
    path: "/v1/trips/join-requests",
    request: "CreateJoinRequestBody",
    response: "MembershipResponse",
    successStatus: "201",
  },
  {
    method: "post",
    operationId: "createTrip",
    parameters: [deviceHeader(), commandHeader()],
    path: "/v1/trips",
    request: "CreateTripBody",
    response: "TripResponse",
    successStatus: "201",
  },
  {
    method: "get",
    operationId: "getTrip",
    parameters: [deviceHeader(), tripPath()],
    path: "/v1/trips/{tripId}",
    request: null,
    response: "TripResponse",
    successStatus: "200",
  },
  {
    method: "post",
    operationId: "registerDevice",
    parameters: [commandHeader()],
    path: "/v1/devices",
    request: "RegisterDeviceBody",
    response: "DeviceResponse",
    successStatus: "201",
  },
  {
    method: "post",
    operationId: "resolveCreateTripOutcome",
    parameters: [deviceHeader(), commandHeader()],
    path: "/v1/trips/create-outcome",
    request: "CreateTripOutcomeBody",
    response: "CreateTripOutcomeResponse",
    successStatus: "200",
  },
  {
    method: "put",
    operationId: "setTripReadiness",
    parameters: [deviceHeader(), commandHeader(), tripPath()],
    path: "/v1/trips/{tripId}/readiness",
    request: "SetTripReadinessBody",
    response: "TripResponse",
    successStatus: "200",
  },
  {
    method: "post",
    operationId: "startTrip",
    parameters: [deviceHeader(), commandHeader(), tripPath()],
    path: "/v1/trips/{tripId}/start",
    request: "StartTripBody",
    response: "TripResponse",
    successStatus: "200",
  },
];

function schemaRef(name) {
  return `#/components/schemas/${name}`;
}

function requireObject(value, description) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function schemaSha256(schema) {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

function validateSecurityScheme(contract) {
  const components = requireObject(contract.components, "OpenAPI components");
  const schemes = requireObject(
    components.securitySchemes,
    "OpenAPI security schemes",
  );
  if (!isDeepStrictEqual(schemes.ClerkBearer, CLERK_BEARER_SCHEME)) {
    throw new Error("ClerkBearer security scheme definition drifted");
  }
}

function parameterIdentity(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return typeof value.name === "string" && typeof value.in === "string"
    ? `${value.in}:${value.name}`
    : null;
}

function validateParameters(operation, expected) {
  if (!Array.isArray(operation.parameters)) {
    throw new Error(`${expected.operationId} parameters must be an array`);
  }

  for (const expectedParameter of expected.parameters) {
    const identity = parameterIdentity(expectedParameter);
    const actual = operation.parameters.find(
      (candidate) => parameterIdentity(candidate) === identity,
    );
    if (actual === undefined) {
      throw new Error(
        `${expected.operationId} ${expectedParameter.name} ${expectedParameter.in} parameter is required`,
      );
    }
    if (!isDeepStrictEqual(actual, expectedParameter)) {
      throw new Error(
        `${expected.operationId} ${expectedParameter.name} ${expectedParameter.in} parameter drifted`,
      );
    }
  }

  for (const actual of operation.parameters) {
    const identity = parameterIdentity(actual);
    if (
      !expected.parameters.some(
        (expectedParameter) =>
          parameterIdentity(expectedParameter) === identity,
      )
    ) {
      const label =
        identity ??
        (typeof actual?.$ref === "string"
          ? actual.$ref.split("/").at(-1)
          : "invalid");
      throw new Error(
        `${expected.operationId} ${label} parameter is unexpected`,
      );
    }
  }

  if (operation.parameters.length !== expected.parameters.length) {
    throw new Error(`${expected.operationId} parameter set drifted`);
  }
}

function validateContent(content, contentType, refName, description) {
  const contentObject = requireObject(content, `${description} content`);
  const contentTypes = Object.keys(contentObject).sort();
  if (!isDeepStrictEqual(contentTypes, [contentType])) {
    throw new Error(`${description} content types drifted`);
  }

  const media = requireObject(
    contentObject[contentType],
    `${description} ${contentType}`,
  );
  if (!isDeepStrictEqual(media.schema, { $ref: schemaRef(refName) })) {
    throw new Error(`${description} schema ref must be ${refName}`);
  }
}

function validateRequest(operation, expected) {
  if (expected.request === null) {
    if (operation.requestBody !== undefined) {
      throw new Error(`${expected.operationId} must not have a request body`);
    }
    return;
  }

  const requestBody = requireObject(
    operation.requestBody,
    `${expected.operationId} request body`,
  );
  if (requestBody.required !== true) {
    throw new Error(`${expected.operationId} request body must be required`);
  }
  validateContent(
    requestBody.content,
    "application/json",
    expected.request,
    `${expected.operationId} request`,
  );
}

function validateResponses(operation, expected) {
  const responses = requireObject(
    operation.responses,
    `${expected.operationId} responses`,
  );
  const expectedStatuses = [expected.successStatus, ...PROBLEM_STATUSES].sort();
  const actualStatuses = Object.keys(responses).sort();
  if (!isDeepStrictEqual(actualStatuses, expectedStatuses)) {
    throw new Error(`${expected.operationId} response statuses drifted`);
  }

  if (expected.response === null) {
    const success = requireObject(
      responses[expected.successStatus],
      `${expected.operationId} response ${expected.successStatus}`,
    );
    if (success.content !== undefined)
      throw new Error(`${expected.operationId} must return no content`);
  } else {
    validateContent(
      requireObject(
        responses[expected.successStatus],
        `${expected.operationId} response ${expected.successStatus}`,
      ).content,
      "application/json",
      expected.response,
      `${expected.operationId} response ${expected.successStatus}`,
    );
  }

  for (const status of PROBLEM_STATUSES) {
    validateContent(
      requireObject(
        responses[status],
        `${expected.operationId} response ${status}`,
      ).content,
      "application/problem+json",
      "ProblemDetails",
      `${expected.operationId} response ${status}`,
    );
  }
}

function validateCreateOutcomeSchemas(contract) {
  const components = requireObject(contract.components, "OpenAPI components");
  const schemas = requireObject(components.schemas, "OpenAPI schemas");
  const body = schemas.CreateTripOutcomeBody;
  const expectedBody = {
    additionalProperties: false,
    type: "object",
    required: ["tripId"],
    properties: { tripId: UUID_V7_SCHEMA },
  };
  if (!isDeepStrictEqual(body, expectedBody)) {
    throw new Error(
      "resolveCreateTripOutcome create-outcome request schema drifted",
    );
  }

  const trip = requireObject(schemas.TripResponse, "TripResponse schema");
  if (schemaSha256(trip) !== ACCEPTED_TRIP_RESPONSE_SCHEMA_SHA256) {
    throw new Error(
      "resolveCreateTripOutcome accepted TripResponse schema drifted",
    );
  }
  const expectedResponse = {
    anyOf: [
      {
        additionalProperties: false,
        type: "object",
        required: ["outcome", "trip"],
        properties: {
          outcome: { const: "COMMITTED", type: "string" },
          trip,
        },
      },
      {
        additionalProperties: false,
        type: "object",
        required: ["outcome"],
        properties: {
          outcome: { const: "TERMINAL_NOT_COMMITTED", type: "string" },
        },
      },
      {
        additionalProperties: false,
        type: "object",
        required: ["outcome"],
        properties: {
          outcome: { const: "STILL_UNKNOWN", type: "string" },
        },
      },
    ],
  };
  if (!isDeepStrictEqual(schemas.CreateTripOutcomeResponse, expectedResponse)) {
    throw new Error(
      "resolveCreateTripOutcome create-outcome response schema drifted",
    );
  }
}

function validateOperation(contract, expected) {
  const pathItem = requireObject(
    contract.paths?.[expected.path],
    expected.operationId,
  );
  if (pathItem.parameters !== undefined) {
    throw new Error(`${expected.operationId} path-level parameters drifted`);
  }
  const expectedMethods = operationExpectations
    .filter((operation) => operation.path === expected.path)
    .map((operation) => operation.method)
    .sort();
  const actualMethods = Object.keys(pathItem)
    .filter((key) => HTTP_METHODS.includes(key))
    .sort();
  if (!isDeepStrictEqual(actualMethods, expectedMethods)) {
    throw new Error(`${expected.operationId} HTTP method set drifted`);
  }
  const operation = requireObject(
    pathItem[expected.method],
    expected.operationId,
  );
  if (operation.operationId !== expected.operationId) {
    throw new Error(`${expected.operationId} operationId drifted`);
  }
  if (!isDeepStrictEqual(operation.security, [{ ClerkBearer: [] }])) {
    throw new Error(`${expected.operationId} must require ClerkBearer`);
  }

  validateParameters(operation, expected);
  validateRequest(operation, expected);
  validateResponses(operation, expected);
}

function renderParameters(operation, lines) {
  lines.push("      parameters: {");
  for (const location of ["query", "header", "path"]) {
    const parameters = operation.parameters.filter(
      (candidate) => candidate.in === location,
    );
    if (parameters.length === 0) continue;
    lines.push(`        ${location}: {`);
    for (const candidate of parameters) {
      lines.push(`          ${JSON.stringify(candidate.name)}: string;`);
    }
    lines.push("        };");
  }
  lines.push("      };");
}

function renderResponses(operation, lines) {
  lines.push("      responses: {");
  lines.push(`        ${operation.successStatus}: {`);
  if (operation.response === null) {
    lines.push("          content?: never;");
  } else {
    lines.push("          content: {");
    lines.push(`            "application/json": ${operation.response};`);
    lines.push("          };");
  }
  lines.push("        };");
  for (const status of PROBLEM_STATUSES) {
    lines.push(`        ${status}: {`);
    lines.push("          content: {");
    lines.push('            "application/problem+json": ProblemDetails;');
    lines.push("          };");
    lines.push("        };");
  }
  lines.push("      };");
}

function renderPaths(lines) {
  lines.push("export type MobilePaths = {");
  for (const routePath of new Set(
    operationExpectations.map((operation) => operation.path),
  )) {
    lines.push(`  ${JSON.stringify(routePath)}: {`);
    for (const operation of operationExpectations.filter(
      (operation) => operation.path === routePath,
    )) {
      lines.push(`    ${operation.method}: {`);
      renderParameters(operation, lines);
      if (operation.request !== null) {
        lines.push("      requestBody: {");
        lines.push("        content: {");
        lines.push(`          "application/json": ${operation.request};`);
        lines.push("        };");
        lines.push("      };");
      }
      renderResponses(operation, lines);
      lines.push("    };");
    }
    lines.push("  };");
  }
  lines.push("};", "");
}

function renderGeneratedTypes() {
  const importedTypes = [
    "AccountPolicy",
    "AcceptTermsBody",
    "DeleteAccountBody",
    "AccountDeletion",
    "SafetyReportBody",
    "SafetyReportResponse",
    "BlockMemberBody",
    "BlockedMembers",
    "AccountActionResponse",
    "TripContinuity",
    "TripContinuityBody",
    "TripListResponse",
    "TripLifecycleBody",
    "TripTransferState",
    "ApproveJoinRequestBody",
    "CreateJoinRequestBody",
    "CreateTripBody",
    "CreateTripOutcomeBody",
    "CreateTripOutcomeResponse",
    "DeviceResponse",
    "MembershipResponse",
    "InvitePreviewBody",
    "InvitePreviewResponse",
    "ProblemDetails",
    "ProfileResponse",
    "RegisterDeviceBody",
    "SetTripReadinessBody",
    "StartTripBody",
    "SyncProfileBody",
    "TripResponse",
  ];
  const lines = [
    "/* This file is generated by tools/generate-mobile-api.mjs. */",
    `import type { ${importedTypes.join(", ")} } from "@crewroll/contracts";`,
    "",
    `export type MobileOperationId = ${requiredOperations.map((id) => JSON.stringify(id)).join(" | ")};`,
    "",
  ];

  renderPaths(lines);
  lines.push("export type MobileOperationMap = {");
  for (const operation of operationExpectations) {
    const headers = operation.parameters
      .filter((candidate) => candidate.in === "header")
      .map((candidate) => candidate.name);
    lines.push(`  ${operation.operationId}: {`);
    lines.push(
      `    method: ${JSON.stringify(operation.method.toUpperCase())};`,
    );
    lines.push(`    path: ${JSON.stringify(operation.path)};`);
    lines.push(
      `    headers: ${headers.length ? headers.map((header) => JSON.stringify(header)).join(" | ") : "never"};`,
    );
    if (operation.request !== null) {
      lines.push(`    request: ${operation.request};`);
    }
    lines.push(`    response: ${operation.response ?? "void"};`);
    lines.push("  };");
  }

  lines.push("};", "");
  return lines.join("\n");
}

export async function generateMobileApi({
  inputPath = path.join(
    root,
    "packages/contracts/generated/crewroll.openapi.json",
  ),
  outputPath = path.join(root, "src/infrastructure/api/generated.ts"),
} = {}) {
  const contract = JSON.parse(await readFile(inputPath, "utf8"));
  requireObject(contract, "OpenAPI document");
  validateSecurityScheme(contract);
  validateCreateOutcomeSchemas(contract);

  for (const expected of operationExpectations) {
    validateOperation(contract, expected);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderGeneratedTypes(), "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generateMobileApi();
}
