import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  generateMobileApi,
  requiredOperations,
} from "./generate-mobile-api.mjs";

const root = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const canonicalInput = path.join(
  root,
  "packages/contracts/generated/crewroll.openapi.json",
);
const createOutcomePath = "/v1/trips/create-outcome";
const problemStatuses = ["400", "401", "403", "404", "409", "429", "500"];

async function withContract(mutator, assertion) {
  const directory = await mkdtemp(path.join(tmpdir(), "crewroll-mobile-api-"));
  const inputPath = path.join(directory, "crewroll.openapi.json");
  const outputPath = path.join(directory, "generated.ts");
  const contract = JSON.parse(await readFile(canonicalInput, "utf8"));

  try {
    await mutator(contract);
    await writeFile(inputPath, `${JSON.stringify(contract, null, 2)}\n`);
    await assertion({ inputPath, outputPath });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("generates the exact bounded current mobile operations deterministically", async () => {
  await withContract(
    async () => undefined,
    async ({ inputPath, outputPath }) => {
      assert.deepEqual(requiredOperations, [
        "approveJoinRequest",
        "createJoinRequest",
        "createTrip",
        "getTrip",
        "registerDevice",
        "resolveCreateTripOutcome",
        "startTrip",
      ]);

      await generateMobileApi({ inputPath, outputPath });
      const first = await readFile(outputPath, "utf8");
      await generateMobileApi({ inputPath, outputPath });
      const second = await readFile(outputPath, "utf8");

      assert.equal(first, second);
      assert.doesNotMatch(first, /\/private\/|Generated at|\\Users\\/);
      assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      assert.doesNotMatch(first, /\bunknown\b|\bResponse\b|status:\s*string/);
      assert.match(first, /export type MobileOperationId =/);
      assert.match(first, /export type MobilePaths =/);
      assert.match(first, /"\/v1\/trips\/create-outcome"/);
      assert.match(first, /resolveCreateTripOutcome/);
    },
  );
});

test("fails generation on every authoritative create-outcome drift", async (t) => {
  const operation = (contract) => contract.paths[createOutcomePath].post;
  const cases = [
    {
      name: "method",
      mutate: (contract) => {
        contract.paths[createOutcomePath].get = operation(contract);
        delete contract.paths[createOutcomePath].post;
      },
    },
    {
      name: "path",
      mutate: (contract) => {
        contract.paths["/v1/trips/create-outcomes"] =
          contract.paths[createOutcomePath];
        delete contract.paths[createOutcomePath];
      },
    },
    {
      name: "operation id",
      mutate: (contract) => {
        operation(contract).operationId = "getCreateTripOutcome";
      },
    },
    {
      name: "security",
      mutate: (contract) => {
        operation(contract).security = [{ BackgroundDeviceBearer: [] }];
      },
    },
    ...["X-CrewRoll-Device-Id", "Idempotency-Key"].map((header) => ({
      name: `${header} header`,
      mutate: (contract) => {
        operation(contract).parameters = operation(contract).parameters.filter(
          (parameter) => parameter.name !== header,
        );
      },
    })),
    {
      name: "request ref",
      mutate: (contract) => {
        operation(contract).requestBody.content[
          "application/json"
        ].schema.$ref = "#/components/schemas/CreateTripBody";
      },
    },
    {
      name: "request schema",
      mutate: (contract) => {
        contract.components.schemas.CreateTripOutcomeBody.properties.tripId = {
          type: "string",
          format: "uuid",
        };
      },
    },
    {
      name: "success status",
      mutate: (contract) => {
        delete operation(contract).responses["200"];
      },
    },
    ...[0, 1, 2].map((branchIndex) => ({
      name: `response union branch ${branchIndex}`,
      mutate: (contract) => {
        contract.components.schemas.CreateTripOutcomeResponse.anyOf.splice(
          branchIndex,
          1,
        );
      },
    })),
    ...problemStatuses.map((status) => ({
      name: `${status} problem response`,
      mutate: (contract) => {
        delete operation(contract).responses[status];
      },
    })),
  ];

  for (const { mutate, name } of cases) {
    await t.test(`rejects ${name}`, async () => {
      await withContract(
        async (contract) => mutate(contract),
        async ({ inputPath, outputPath }) => {
          await assert.rejects(
            generateMobileApi({ inputPath, outputPath }),
            /resolveCreateTripOutcome|create-outcome/i,
          );
        },
      );
    });
  }
});

test("fails generation when an accepted operation drifts", async () => {
  await withContract(
    async (contract) => {
      delete contract.paths["/v1/trips"].post.operationId;
    },
    async ({ inputPath, outputPath }) => {
      await assert.rejects(
        generateMobileApi({ inputPath, outputPath }),
        /createTrip.*operationId/i,
      );
    },
  );
});

test("fails generation when Clerk security, required headers, or body schema drift", async (t) => {
  const cases = [
    {
      mutate: (contract) => {
        contract.paths["/v1/trips"].post.security = [
          { BackgroundDeviceBearer: [] },
        ];
      },
      name: "security",
      pattern: /createTrip.*ClerkBearer/i,
    },
    {
      mutate: (contract) => {
        contract.paths["/v1/trips"].post.parameters = contract.paths[
          "/v1/trips"
        ].post.parameters.filter(
          (parameter) => parameter.name !== "Idempotency-Key",
        );
      },
      name: "header",
      pattern: /createTrip.*Idempotency-Key/i,
    },
    {
      mutate: (contract) => {
        contract.paths["/v1/trips"].post.requestBody.content[
          "application/json"
        ].schema.$ref = "#/components/schemas/UnexpectedCreateTripBody";
      },
      name: "schema ref",
      pattern: /createTrip.*CreateTripBody/i,
    },
  ];

  for (const { mutate, name, pattern } of cases) {
    await t.test(`rejects ${name} drift`, async () => {
      await withContract(
        async (contract) => mutate(contract),
        async ({ inputPath, outputPath }) => {
          await assert.rejects(
            generateMobileApi({ inputPath, outputPath }),
            pattern,
          );
        },
      );
    });
  }
});

test("fails generation when the ClerkBearer scheme definition drifts", async () => {
  await withContract(
    async (contract) => {
      contract.components.securitySchemes.ClerkBearer.bearerFormat = "JWT";
    },
    async ({ inputPath, outputPath }) => {
      await assert.rejects(
        generateMobileApi({ inputPath, outputPath }),
        /ClerkBearer.*definition/i,
      );
    },
  );
});

test("fails generation on exact header, path, and query parameter drift", async (t) => {
  const cases = [
    {
      mutate: (contract) => {
        const header = contract.paths["/v1/trips"].post.parameters.find(
          (parameter) => parameter.name === "Idempotency-Key",
        );
        header.schema.format = "crewroll-command-id";
      },
      name: "header schema",
      pattern: /createTrip.*Idempotency-Key.*parameter/i,
    },
    {
      mutate: (contract) => {
        contract.paths["/v1/trips/{tripId}"].get.parameters = contract.paths[
          "/v1/trips/{tripId}"
        ].get.parameters.filter((parameter) => parameter.name !== "tripId");
      },
      name: "required tripId path parameter",
      pattern: /getTrip.*tripId.*parameter/i,
    },
    {
      mutate: (contract) => {
        contract.paths["/v1/trips/{tripId}"].get.parameters.push({
          in: "query",
          name: "includeSecrets",
          required: false,
          schema: { type: "boolean" },
        });
      },
      name: "unexpected query parameter",
      pattern: /getTrip.*includeSecrets.*parameter/i,
    },
    {
      mutate: (contract) => {
        const parameters = contract.paths["/v1/trips/{tripId}"].get.parameters;
        const index = parameters.findIndex(
          (parameter) => parameter.name === "tripId",
        );
        parameters[index] = {
          $ref: "#/components/parameters/TripId",
        };
      },
      name: "parameter ref",
      pattern: /getTrip.*tripId.*parameter/i,
    },
  ];

  for (const { mutate, name, pattern } of cases) {
    await t.test(`rejects ${name}`, async () => {
      await withContract(
        async (contract) => mutate(contract),
        async ({ inputPath, outputPath }) => {
          await assert.rejects(
            generateMobileApi({ inputPath, outputPath }),
            pattern,
          );
        },
      );
    });
  }
});

test("fails generation on extra request or response content types", async (t) => {
  const cases = [
    {
      mutate: (contract) => {
        contract.paths["/v1/trips"].post.requestBody.content["text/plain"] = {
          schema: { type: "string" },
        };
      },
      name: "request text/plain",
      pattern: /createTrip.*request.*content/i,
    },
    {
      mutate: (contract) => {
        contract.paths["/v1/trips"].post.responses["201"].content[
          "text/plain"
        ] = { schema: { type: "string" } };
      },
      name: "response text/plain",
      pattern: /createTrip.*response 201.*content/i,
    },
  ];

  for (const { mutate, name, pattern } of cases) {
    await t.test(`rejects ${name}`, async () => {
      await withContract(
        async (contract) => mutate(contract),
        async ({ inputPath, outputPath }) => {
          await assert.rejects(
            generateMobileApi({ inputPath, outputPath }),
            pattern,
          );
        },
      );
    });
  }
});
