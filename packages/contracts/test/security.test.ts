import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CommitAssetResponseSchema,
  DeviceResponseSchema,
  DownloadSessionResponseSchema,
  InviteResponseSchema,
  MembershipResponseSchema,
  ProblemDetailsSchema,
  ReconciliationResponseSchema,
  SavedReceiptResponseSchema,
  SyncResponseSchema,
  TripResponseSchema,
  UploadSessionResponseSchema,
} from "../openapi/index.js";
import {
  AssetPageSchema,
  CreateTripKeyResultSchema,
  DurableEngineSnapshotSchema,
  NativeDeviceIdentitySchema,
  RevisionInvalidationSchema,
  WrapTripKeyResultSchema,
} from "../native/protocol.js";

type SecurityDocument = "key-lifecycle.md" | "threat-model.md";

type JsonSchemaNode = {
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly items?: unknown;
  readonly anyOf?: readonly unknown[];
  readonly oneOf?: readonly unknown[];
  readonly allOf?: readonly unknown[];
};

const responseSchemas = {
  AssetPageSchema,
  CommitAssetResponseSchema,
  CreateTripKeyResultSchema,
  DeviceResponseSchema,
  DownloadSessionResponseSchema,
  DurableEngineSnapshotSchema,
  InviteResponseSchema,
  MembershipResponseSchema,
  NativeDeviceIdentitySchema,
  ProblemDetailsSchema,
  ReconciliationResponseSchema,
  RevisionInvalidationSchema,
  SavedReceiptResponseSchema,
  SyncResponseSchema,
  TripResponseSchema,
  UploadSessionResponseSchema,
  WrapTripKeyResultSchema,
} as const;

const forbiddenResponseLeafNames = new Set([
  "authenticationPrivateKey",
  "ciphertextPath",
  "contentKey",
  "decryptedPath",
  "e2eePrivateKey",
  "exif",
  "filename",
  "filesystemPath",
  "latitude",
  "location",
  "longitude",
  "mediaKey",
  "originalKey",
  "plaintextFilename",
  "plaintextHash",
  "plaintextPath",
  "plaintextSha256",
  "previewKey",
  "privateKey",
  "rawSourceId",
  "sourceHmacKey",
  "sourceLibraryId",
  "tempPath",
  "tripKey",
]);

function readSecurityDocument(filename: SecurityDocument): string {
  return readFileSync(
    new URL(`../../../docs/security/${filename}`, import.meta.url),
    "utf8",
  );
}

function expectAllMarkers(
  document: string,
  label: string,
  markers: readonly string[],
): void {
  for (const marker of markers) {
    expect(document, `${label} is missing: ${marker}`).toContain(marker);
  }
}

function asSchemaNode(value: unknown): JsonSchemaNode | undefined {
  return value !== null && typeof value === "object" ? value : undefined;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function collectPropertyPaths(value: unknown, prefix = ""): string[] {
  const node = asSchemaNode(value);
  if (node === undefined) {
    return [];
  }

  const paths: string[] = [];

  for (const [propertyName, child] of Object.entries(node.properties ?? {})) {
    const propertyPath = prefix ? `${prefix}.${propertyName}` : propertyName;
    paths.push(propertyPath);
    paths.push(...collectPropertyPaths(child, propertyPath));
  }

  const children: unknown[] = [
    ...(node.anyOf ?? []),
    ...(node.oneOf ?? []),
    ...(node.allOf ?? []),
  ];
  if (isUnknownArray(node.items)) {
    children.push(...node.items);
  } else if (node.items !== undefined) {
    children.push(node.items);
  }

  for (const child of children) {
    paths.push(...collectPropertyPaths(child, prefix));
  }

  return paths;
}

describe("SEC-001 threat model", () => {
  it("binds the qualified confidentiality claim and honest-directory boundary", () => {
    const document = readSecurityDocument("threat-model.md");

    expectAllMarkers(document, "threat model", [
      "Enrolled recipient devices are plaintext endpoints.",
      "assuming the backend-supplied device public-key directory was authentic when the owner approved envelopes.",
      "It is not an active-malicious-server claim.",
      "A first-import, context-correct replacement trip envelope",
      "Sealed boxes are anonymous",
      "`ACTIVE` cannot transition to `REJECTED`",
      "Start freezes membership, participating device, and key epoch.",
      "same frozen participating device may fetch and re-import its own opaque envelope",
      "Loss of that device's X25519 private key cannot be repaired after Start.",
    ]);
  });

  it("binds the visibility, redaction, and downstream-evidence boundaries", () => {
    const document = readSecurityDocument("threat-model.md");

    expectAllMarkers(document, "threat model", [
      "access-controlled OpenTelemetry **trace attributes only**",
      "opaque `tripId`, `assetId`, and `deliveryId`",
      "`capturedAt`",
      "CreateUploadSessionBody",
      "ReconciliationResponseSchema",
      "Runtime serializer canaries are downstream acceptance gates",
      "SEC-001 tests documentation and extant response schemas only.",
    ]);
  });
});

describe("SEC-001 key lifecycle", () => {
  it("pins key sizes, encodings, envelope layout, and canonical AAD", () => {
    const document = readSecurityDocument("key-lifecycle.md");

    expectAllMarkers(document, "key lifecycle", [
      "exactly 65 decoded bytes",
      "exactly 32 decoded bytes",
      "`CRTKENV1`",
      "exactly 100 bytes",
      "exactly 148 bytes",
      "exactly 200 ASCII characters",
      "`CRMANF01`",
      "exact 94-byte AAD",
      "`CRROLL01`",
      "`CRROLL-AAD-V1\\0`",
      "exact 95-byte AAD",
      "256 KiB plaintext frames",
      "`TAG_FINAL`",
    ]);
  });

  it("pins native ownership, recoverability, protected staging, and deletion", () => {
    const document = readSecurityDocument("key-lifecycle.md");

    expectAllMarkers(document, "key lifecycle", [
      "`importTripKey` is the only operation",
      "`activateTrip` only selects an already-installed key",
      "`discardProvisionalTripKey`",
      "24 hours",
      "ACTIVE --deactivate/logout--------------------------------------> INSTALLED",
      "authenticated trip End",
      "same-device recovery",
      "kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly",
      "NSFileProtectionCompleteUntilFirstUserAuthentication",
      "credential-encrypted, app-private, no-backup storage",
      "15 minutes",
      "`hard_delete_at`",
      "No command returns trip keys",
    ]);
  });
});

describe("SEC-001 public response schemas", () => {
  it("does not expose private keys, media keys, raw source IDs, or plaintext paths", () => {
    for (const [schemaName, schema] of Object.entries(responseSchemas)) {
      const forbiddenPaths = collectPropertyPaths(schema).filter((path) => {
        const leafName = path.slice(path.lastIndexOf(".") + 1);
        return forbiddenResponseLeafNames.has(leafName);
      });

      expect(
        forbiddenPaths,
        `${schemaName} exposes forbidden response fields`,
      ).toEqual([]);
    }
  });
});
