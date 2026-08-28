# CrewRoll Mobile and Native Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the photo-only CrewRoll mobile application from a clean Expo SDK 57 foundation so a stock-camera photo is discovered, encrypted on the source device, delivered through temporary object storage, saved exactly once into every recipient's system library, acknowledged, and deleted from temporary storage.

**Architecture:** The React Native application owns routes, commands, and durable server projections. A single local Expo module owns PhotoKit/MediaStore discovery, native persistence, encryption, background upload/download, integrity verification, and system-library saves. Push and native callbacks only invalidate projections; PostgreSQL inbox cursors and the native job database are the durable sources of truth.

**Tech Stack:** Node.js 22, npm 10 workspaces, Expo SDK 57, React Native 0.86, React 19.2, TypeScript, Expo Router, TanStack Query, Zustand, Zod, `openapi-fetch`, Jest Expo, React Native Testing Library, Maestro, Swift, PhotoKit, BackgroundTasks, background URLSession, GRDB, Kotlin, Room, MediaStore, JobScheduler, WorkManager, OkHttp, and native libsodium secretstream.

**Spec:** `docs/superpowers/specs/2026-08-28-crewroll-greenfield-blueprint-design.md`

## Global Constraints

- Preserve iOS bundle identifier `com.uankit53.airmesh`.
- Preserve Android package `com.uankit53.airmesh`.
- Preserve Expo slug `AirMesh`, URL scheme `airmesh`, and app version `0.2.0` until the release task deliberately advances the version.
- Preserve EAS project ID `fe1de141-5c42-4250-9c1f-f7313845dc8e`, updates URL `https://u.expo.dev/fe1de141-5c42-4250-9c1f-f7313845dc8e`, remote app-version source, and production auto-increment.
- Use Expo SDK 57's New Architecture; it cannot be disabled.
- Keep newly generated root `ios/` and `android/` directories out of version control. If `GOV-001` finds tracked signed native projects, preserve them byte-for-byte and never delete or overwrite their signing files. Native behavior lives in a local Expo module and config plugin so clean prebuilds are reproducible when no protected root project exists.
- Implement photos only. Do not add video branches, multipart video behavior, or poster generation.
- Maximum trip membership is 10, and a user may have only one pending or active trip.
- Do not add P2P, LAN transfer, WebSocket byte relay, Google Drive, alternate storage transports, or runtime transport selection.
- Do not use PhotoKit Background Resource Upload. It sends raw `PHAssetResource` data and conflicts with the E2EE contract.
- The only iOS source path is PhotoKit observation/persistent-change reconciliation, native encryption, ciphertext staging, and background `URLSession`.
- State the force-quit limitation in product copy and acceptance tests: iOS cancels background transfers and will not relaunch a user-force-quit app; reconciliation resumes after the next explicit launch.
- The only Android source path uses MediaStore version/generation reconciliation, content-change wakeups, WorkManager, native encryption, and OkHttp.
- Set Android minimum SDK to API 30. Do not implement a date-based MediaStore compatibility branch.
- Preserve exact source bytes. Only previews may be recompressed.
- Use native libsodium `crypto_secretstream_xchacha20poly1305`. Do not implement cryptography in JavaScript.
- Persist work before starting network I/O. Every command, receipt, upload commit, and system-library save is idempotent.
- Keep retry metadata orthogonal to monotonic work stages. Pause gates scheduling; it is not a transfer stage.
- Use test-driven development, one reviewer-sized task per commit, and never mix unrelated cleanup into a task.

---

## Execution Precedence

This plan expands the mobile/native portion of the repository-wide backlog; it is not a competing source of truth. Resolve conflicts in this order:

1. `docs/TECHNICAL_TASKS.md` owns task IDs, dependency gates, execution order, and acceptance criteria.
2. `docs/superpowers/specs/2026-08-28-crewroll-greenfield-blueprint-design.md` owns the locked architecture and privacy invariants.
3. `CON-001` through `CON-003` and Task 1 of `docs/superpowers/plans/2026-08-28-crewroll-control-plane.md` own `packages/contracts/**`, canonical TypeBox schemas, the generated OpenAPI document, crypto framing, and shared fixtures.
4. This plan owns only the root Expo client, `src/**` mobile code, and `modules/crewroll-transfer/**`. Mobile generates and consumes a typed client from the upstream OpenAPI artifact; it never defines or edits the canonical wire contract.

Complete `GOV-001`, `FND-001`, `FND-002`, `CON-001`, `CON-002`, `CON-003`, and `SEC-001` before starting this plan, plus the corresponding `API-*` dependency before calling each server route. If an upstream artifact differs from an example here, update the mobile adapter to the upstream contract; do not fork, shadow, or coerce the contract.

The greenfield reset is already represented by the locked repository state. Do not rerun scaffolding, move Expo below the repository root, replace `app.json`, delete root files, or change workspace topology. The root package remains `crewroll`; root workspaces remain exactly `packages/*` and `services/*`.

## Locked File Map

```text
./
  app.json
  eas.json
  package.json
  app/
  src/bootstrap/
  src/design-system/
  src/domain/
  src/features/auth/
  src/features/trips/
  src/features/transfer/
  src/features/reconciliation/
  src/shared/api/
  src/shared/config/
  src/shared/native/
  src/shared/test/
  modules/crewroll-transfer/
    expo-module.config.json
    index.ts
    src/
    plugin/
    ios/
    android/
  packages/contracts/          # upstream-owned input; mobile tasks never edit it
  services/control-plane/      # upstream-owned; mobile tasks never edit it
  tests/maestro/
  tools/
    app-identity.snapshot.json
    app-identity.mjs
    app-identity.test.mjs
    verify-app-identity.mjs
```

The Expo routes remain thin. Feature directories own view models, API hooks, and screens. The native engine owns all transfer state and binary work. The JavaScript bridge exposes commands and projections only.

### Task 1: Extend the Locked Root Identity Gate

**Files:**
- Test: `tools/app-identity.test.mjs`
- Modify: `tools/app-identity.mjs`
- Modify: `tools/verify-app-identity.mjs`
- Verify only: `tools/app-identity.snapshot.json`
- Verify only: `app.json`
- Verify only: `eas.json`
- Verify only: `package.json`

**Interfaces:**
- Consumes: the identity snapshot and resolved output of `npx expo config --type public --json`
- Produces: `assertRootManifest(manifest: RootManifest): void`
- Preserves: every identity value already enforced by `assertAppIdentity`

- [ ] **Step 1: Add failing root-shape tests**

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { assertRootManifest } from "./app-identity.mjs";

const validRoot = {
  name: "crewroll",
  private: true,
  main: "expo-router/entry",
  workspaces: ["packages/*", "services/*"],
  dependencies: { expo: "~57.0.18" },
};

test("accepts the locked root Expo manifest", () => {
  assert.doesNotThrow(() => assertRootManifest(validRoot));
});

test("rejects a renamed root application", () => {
  assert.throws(
    () => assertRootManifest({ ...validRoot, name: "mobile" }),
    /package name/,
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tools/app-identity.test.mjs`

Expected: FAIL because `assertRootManifest` is not exported.

- [ ] **Step 3: Implement exact root assertions**

```javascript
export function assertRootManifest(manifest) {
  assert.equal(manifest.name, "crewroll", "package name must remain crewroll");
  assert.equal(manifest.private, true, "root package must remain private");
  assert.equal(manifest.main, "expo-router/entry", "Expo Router must stay at repository root");
  assert.deepEqual(manifest.workspaces, ["packages/*", "services/*"], "workspace topology");
  assert.match(manifest.dependencies?.expo ?? "", /^~57\./, "Expo SDK 57");
}
```

Export the assertion from `tools/app-identity.mjs`. In `tools/verify-app-identity.mjs`, read root `package.json`, call `assertRootManifest`, then run the existing Expo config assertions. Do not mutate any protected configuration.

- [ ] **Step 4: Run the complete identity gate**

Run: `node --test tools/app-identity.test.mjs && npm run verify:identity`

Expected: PASS; the root topology and all protected store/EAS identifiers remain exact.

- [ ] **Step 5: Commit only the strengthened verifier**

```bash
git add tools/app-identity.mjs tools/app-identity.test.mjs tools/verify-app-identity.mjs
git commit -m "test: guard CrewRoll root mobile identity"
```

### Task 2: Install the Root Mobile Dependency Baseline

**Files:**
- Test: `tools/mobile-dependencies.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: one root Expo application whose package name remains `crewroll`
- Produces: root dependencies for auth, queries, validation, generated HTTP, forms, lists, notifications, and native development builds
- Preserves: workspaces `packages/*` and `services/*`; `app.json`; `eas.json`; EAS/store identity; any tracked signing infrastructure

- [ ] **Step 1: Write the failing dependency-boundary test**

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("keeps the root Expo shape and approved client stack", () => {
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(root.name, "crewroll");
  assert.equal(root.main, "expo-router/entry");
  assert.deepEqual(root.workspaces, ["packages/*", "services/*"]);
  for (const name of [
    "@clerk/clerk-expo",
    "@shopify/flash-list",
    "@tanstack/react-query",
    "openapi-fetch",
    "react-hook-form",
    "zod",
    "zustand",
  ]) {
    assert.equal(typeof root.dependencies[name], "string", `missing ${name}`);
  }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tools/mobile-dependencies.test.mjs`

Expected: FAIL on the first approved dependency that is not yet installed.

- [ ] **Step 3: Install Expo-managed dependencies at the root**

Run:

```bash
npx expo install expo-dev-client expo-updates expo-constants expo-linking expo-haptics expo-image expo-splash-screen expo-status-bar expo-system-ui expo-build-properties expo-secure-store expo-notifications expo-task-manager expo-device
```

Expected: Expo selects SDK-57-compatible versions and changes only the root manifest and lockfile.

- [ ] **Step 4: Install application dependencies at the root**

Run:

```bash
npm install --save-exact @clerk/clerk-expo @tanstack/react-query zustand zod openapi-fetch react-hook-form @hookform/resolvers @shopify/flash-list
npm install --save-dev --save-exact openapi-typescript
```

Expected: npm preserves the root name, entrypoint, and two workspace globs.

- [ ] **Step 5: Run dependency, identity, and SDK compatibility gates**

Run: `node --test tools/mobile-dependencies.test.mjs && npm run verify:identity && npm run doctor`

Expected: all commands pass and Expo Doctor reports no incompatible SDK dependency.

- [ ] **Step 6: Commit the root dependency baseline**

```bash
git add package.json package-lock.json tools/mobile-dependencies.test.mjs
git commit -m "chore: add root mobile dependency baseline"
```

### Task 3: Establish TypeScript, Environment, and Test Quality Gates

**Files:**
- Create: `src/shared/config/env.ts`
- Create: `src/shared/config/env.test.ts`
- Create: `src/shared/test/render.tsx`
- Modify: `package.json`
- Verify only: `eslint.config.js`
- Verify only: `tsconfig.json`

**Interfaces:**
- Produces: `readPublicEnv(source): PublicEnv`
- Produces: one `npm run check` command for TypeScript, lint, and Jest

- [ ] **Step 1: Write the failing environment contract**

```typescript
import { readPublicEnv } from "./env";

describe("readPublicEnv", () => {
  it("accepts an HTTPS API origin", () => {
    expect(readPublicEnv({ EXPO_PUBLIC_API_URL: "https://api.crewroll.app" })).toEqual({
      apiUrl: "https://api.crewroll.app",
    });
  });

  it("rejects an HTTP production origin", () => {
    expect(() => readPublicEnv({ EXPO_PUBLIC_API_URL: "http://api.crewroll.app" }))
      .toThrow("EXPO_PUBLIC_API_URL");
  });
});
```

- [ ] **Step 2: Run Jest and verify the missing module failure**

Run: `npm run test:ui -- src/shared/config/env.test.ts`

Expected: FAIL because `env.ts` does not exist.

- [ ] **Step 3: Implement strict environment parsing**

```typescript
import { z } from "zod";

const PublicEnvSchema = z.object({
  EXPO_PUBLIC_API_URL: z.string().url().startsWith("https://"),
});

export type PublicEnv = { readonly apiUrl: string };

export function readPublicEnv(source: Record<string, string | undefined>): PublicEnv {
  const parsed = PublicEnvSchema.parse(source);
  return { apiUrl: parsed.EXPO_PUBLIC_API_URL.replace(/\/$/, "") };
}
```

- [ ] **Step 4: Retain the canonical root quality scripts**

Set the mobile scripts to:

```json
{
  "typecheck": "tsc --noEmit",
  "lint": "expo lint",
  "test": "npm run test:tools && npm run test:ui",
  "test:tools": "node --test tools/*.test.mjs",
  "test:ui": "jest --runInBand",
  "verify:bundle": "expo export --platform ios --output-dir dist/ios && expo export --platform android --output-dir dist/android",
  "check": "npm run verify:identity && npm run typecheck && npm run lint && npm run test && npm run doctor"
}
```

- [ ] **Step 5: Run every quality gate**

Run: `npm run check`

Expected: TypeScript, ESLint, and both environment tests pass.

- [ ] **Step 6: Commit the environment boundary**

```bash
git add package.json src/shared/config src/shared/test/render.tsx
git commit -m "feat: add validated mobile environment"
```

### Task 4: Generate and Adapt the Upstream API Client

**Files:**
- Consume only: `packages/contracts/generated/crewroll.openapi.json`
- Consume only: `packages/contracts/fixtures/http.ts`
- Create: `tools/generate-mobile-api.mjs`
- Create: `src/shared/api/generated.ts`
- Create: `src/shared/api/client.ts`
- Create: `src/shared/api/client.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the OpenAPI 3.1 artifact, TypeBox types, and fixtures produced by `CON-001` through `CON-003` and control-plane Task 1
- Produces: deterministic root command `npm run generate:mobile-api`
- Produces: `createCrewRollApiClients(input): { user: Client<paths>; device: Client<paths> }`
- Security boundary: user commands use a Clerk credential; native/background media commands use a revocable device credential; neither adapter accepts local file paths, plaintext metadata, media keys, or a device-local exactness hash

- [ ] **Step 1: Verify the upstream contract prerequisite**

Run:

```bash
npm run test -w @crewroll/contracts
npm run openapi:generate -w @crewroll/contracts
test -f packages/contracts/generated/crewroll.openapi.json
```

Expected: every command passes. If the artifact is absent, stop and complete `CON-003`; do not create a mobile-owned schema.

- [ ] **Step 2: Write failing adapter tests**

```typescript
import { createCrewRollApiClients } from "./client";
import { validDeviceBody } from "@crewroll/contracts/fixtures/http";

it("separates user and background device credentials", async () => {
  const fetch = jest.fn(async (request: Request) => new Response("{}", {
    status: 200,
    headers: { "X-CrewRoll-Protocol-Version": "1" },
  }));
  const clients = createCrewRollApiClients({
    baseUrl: "https://api.crewroll.app",
    getUserToken: async () => "user-token",
    getDeviceToken: async () => "device-token",
    fetch,
  });

  await clients.user.POST("/v1/devices", { body: validDeviceBody() });
  await clients.device.GET("/v1/sync");

  expect((fetch.mock.calls[0][0] as Request).headers.get("Authorization"))
    .toBe("Bearer user-token");
  expect((fetch.mock.calls[1][0] as Request).headers.get("Authorization"))
    .toBe("Bearer device-token");
});

it("fails closed on an unknown wire version", async () => {
  const fetch = async () => new Response("{}", {
    status: 200,
    headers: { "X-CrewRoll-Protocol-Version": "2" },
  });
  const clients = createCrewRollApiClients({
    baseUrl: "https://api.crewroll.app",
    getUserToken: async () => "user-token",
    getDeviceToken: async () => "device-token",
    fetch,
  });

  await expect(clients.device.GET("/v1/sync"))
    .rejects.toThrow("Unsupported CrewRoll protocol version: 2");
});
```

- [ ] **Step 3: Run the adapter tests and verify RED**

Run: `npm run test:ui -- src/shared/api/client.test.ts`

Expected: FAIL because `createCrewRollApiClients` and `generated.ts` do not exist.

- [ ] **Step 4: Add deterministic client generation**

`tools/generate-mobile-api.mjs` invokes `openapi-typescript` with `packages/contracts/generated/crewroll.openapi.json` as input and `src/shared/api/generated.ts` as output. It rejects generated output containing an absolute workspace path or a generation timestamp. Add:

```json
{
  "scripts": {
    "generate:mobile-api": "node tools/generate-mobile-api.mjs"
  },
  "dependencies": {
    "@crewroll/contracts": "*"
  }
}
```

Run twice:

```bash
npm run generate:mobile-api
cp src/shared/api/generated.ts /private/tmp/crewroll-generated.ts
npm run generate:mobile-api
cmp src/shared/api/generated.ts /private/tmp/crewroll-generated.ts
```

Expected: the first run creates the client and the second run is byte-for-byte identical.

- [ ] **Step 5: Implement separate authenticated adapters**

```typescript
import createClient from "openapi-fetch";
import type { paths } from "./generated";

type TokenProvider = () => Promise<string>;

type ClientInput = {
  baseUrl: string;
  getUserToken: TokenProvider;
  getDeviceToken: TokenProvider;
  fetch?: typeof globalThis.fetch;
};

function createAuthenticatedClient(input: ClientInput, getToken: TokenProvider) {
  const client = createClient<paths>({ baseUrl: input.baseUrl, fetch: input.fetch });
  client.use({
    async onRequest({ request }) {
      request.headers.set("Authorization", `Bearer ${await getToken()}`);
      request.headers.set("Accept", "application/json");
      request.headers.set("X-CrewRoll-Protocol-Version", "1");
      return request;
    },
    async onResponse({ response }) {
      const version = response.headers.get("X-CrewRoll-Protocol-Version");
      if (version !== "1") {
        throw new Error(`Unsupported CrewRoll protocol version: ${version ?? "missing"}`);
      }
      return response;
    },
  });
  return client;
}

export function createCrewRollApiClients(input: ClientInput) {
  return {
    user: createAuthenticatedClient(input, input.getUserToken),
    device: createAuthenticatedClient(input, input.getDeviceToken),
  } as const;
}
```

The native media adapter serializes only upstream contract fields. The encrypted manifest is opaque ciphertext to JavaScript and the server. A local plaintext digest may be calculated and compared inside native code for exactness, but it is never added to HTTP bodies, headers, logs, analytics, push, or public database fields.

- [ ] **Step 6: Verify generation, adapter behavior, and upstream ownership**

Run:

```bash
npm run generate:mobile-api
npm run test:ui -- src/shared/api/client.test.ts
npm run typecheck
git diff --exit-code -- packages/contracts
```

Expected: all commands pass and the final command proves this task did not edit the canonical contract package.

- [ ] **Step 7: Commit only mobile client artifacts**

```bash
git add package.json package-lock.json tools/generate-mobile-api.mjs src/shared/api
git commit -m "feat: consume generated CrewRoll API client"
```

### Task 5: Build the Design-System Foundation

**Files:**
- Create: `src/design-system/tokens/color.ts`
- Create: `src/design-system/tokens/spacing.ts`
- Create: `src/design-system/tokens/radius.ts`
- Create: `src/design-system/tokens/typography.ts`
- Create: `src/design-system/tokens/motion.ts`
- Create: `src/design-system/components/AppText.tsx`
- Create: `src/design-system/components/Button.tsx`
- Create: `src/design-system/components/Card.tsx`
- Create: `src/design-system/components/Field.tsx`
- Create: `src/design-system/components/IconButton.tsx`
- Create: `src/design-system/components/ProgressRow.tsx`
- Create: `src/design-system/components/Screen.tsx`
- Create: `src/design-system/components/StatusBadge.tsx`
- Create: `src/design-system/index.ts`
- Create: `src/design-system/design-system.test.tsx`

**Interfaces:**
- Produces typed semantic tokens; feature code does not import raw palette values
- Produces accessible primitives with loading, pressed, disabled, and error variants

- [ ] **Step 1: Write failing token and accessibility tests**

```typescript
import { fireEvent, render } from "@testing-library/react-native";
import { Button } from "./components/Button";
import { darkColors, lightColors } from "./tokens/color";

it("defines every semantic color in both schemes", () => {
  expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
});

it("prevents a disabled button from invoking its action", () => {
  const onPress = jest.fn();
  const view = render(<Button label="Start trip" disabled onPress={onPress} />);
  fireEvent.press(view.getByRole("button"));
  expect(onPress).not.toHaveBeenCalled();
  expect(view.getByRole("button")).toHaveAccessibilityState({ disabled: true });
});
```

- [ ] **Step 2: Run the design-system test**

Run: `npm run test:ui -- src/design-system/design-system.test.tsx`

Expected: FAIL because tokens and Button are absent.

- [ ] **Step 3: Add the semantic color contract**

```typescript
export const lightColors = {
  canvas: "#F7F9FC",
  surface: "#FFFFFF",
  surfaceRaised: "#EEF3FA",
  accent: "#0B63CE",
  accentPressed: "#084FAD",
  textPrimary: "#071522",
  textSecondary: "#526174",
  textInverse: "#FFFFFF",
  border: "#CCD6E4",
  success: "#147A4B",
  warning: "#9B6100",
  danger: "#B4232A",
} as const;

export const darkColors: Record<keyof typeof lightColors, string> = {
  canvas: "#020A12",
  surface: "#0A1724",
  surfaceRaised: "#11253A",
  accent: "#1675FF",
  accentPressed: "#0F5FCC",
  textPrimary: "#F4F8FC",
  textSecondary: "#A8B7C8",
  textInverse: "#020A12",
  border: "#263B50",
  success: "#42C98A",
  warning: "#FFCA64",
  danger: "#FF737A",
};
```

- [ ] **Step 4: Add spacing, radius, typography, and motion**

Use the exact scales:

```typescript
export const spacing = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48 } as const;
export const radius = { small: 10, medium: 16, large: 24, pill: 999 } as const;
export const typography = {
  display: { fontSize: 36, lineHeight: 42, fontWeight: "700" },
  title: { fontSize: 24, lineHeight: 30, fontWeight: "700" },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  label: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
} as const;
export const motion = { instant: 0, fast: 120, standard: 220 } as const;
```

- [ ] **Step 5: Implement the eight primitives and rerun tests**

Every press target has a minimum 48-by-48 point hit area, every text component permits Dynamic Type, and motion uses zero duration when Reduce Motion is enabled.

Run: `npm run test:ui -- src/design-system/design-system.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the design system**

```bash
git add src/design-system
git commit -m "feat: add CrewRoll design system"
```

### Task 6: Scaffold the Native Engine Bridge and Config Plugin

**Files:**
- Create: `modules/crewroll-transfer/expo-module.config.json`
- Create: `modules/crewroll-transfer/index.ts`
- Create: `modules/crewroll-transfer/src/CrewRollTransfer.types.ts`
- Create: `modules/crewroll-transfer/src/CrewRollTransferModule.ts`
- Create: `modules/crewroll-transfer/plugin/withCrewRollTransfer.ts`
- Create: `modules/crewroll-transfer/plugin/withCrewRollTransfer.test.ts`
- Create: `modules/crewroll-transfer/ios/CrewRollTransfer.podspec`
- Create: `modules/crewroll-transfer/ios/CrewRollTransferModule.swift`
- Create: `modules/crewroll-transfer/android/build.gradle`
- Create: `modules/crewroll-transfer/android/src/main/AndroidManifest.xml`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/CrewRollTransferModule.kt`
- Create: `src/shared/native/crewRollTransfer.ts`
- Create: `src/shared/native/crewRollTransfer.test.ts`
- Modify: `app.json`

**Interfaces:**
- Produces the exact `CrewRollTransferModule` methods defined below
- Emits only `engineInvalidated({ revision: number })`
- Configures iOS photo permissions/background processing and Android API 30/media permissions

- [ ] **Step 1: Write the failing TypeScript bridge test**

```typescript
import type { CrewRollTransferPort } from "./crewRollTransfer";

it("exposes commands and durable projections only", () => {
  const methodNames: Array<keyof CrewRollTransferPort> = [
    "ensureDeviceIdentity",
    "installDeviceSession",
    "activateTrip",
    "deactivateTrip",
    "setTransferPolicy",
    "reconcileNow",
    "retry",
    "getSnapshot",
    "listAssets",
  ];
  expect(methodNames).toHaveLength(9);
});
```

- [ ] **Step 2: Run the bridge test**

Run: `npm run test:ui -- src/shared/native/crewRollTransfer.test.ts`

Expected: FAIL because the port is absent.

- [ ] **Step 3: Define the bridge types**

```typescript
export type NativeDeviceIdentity = {
  readonly installationId: string;
  readonly identityPublicKey: string;
  readonly identityKeyVersion: 1;
  readonly encryptionPublicKey: string;
};

export type EngineBlocker =
  | "PHOTO_PERMISSION"
  | "STORAGE_FULL"
  | "AUTH_REVOKED"
  | "SOURCE_MISSING"
  | "INTEGRITY_FAILURE";

export type EngineSnapshot = {
  readonly revision: number;
  readonly activeTripId: string | null;
  readonly paused: boolean;
  readonly counts: {
    readonly discovered: number;
    readonly previewReady: number;
    readonly originalsSaved: number;
    readonly blocked: number;
  };
  readonly blockers: readonly EngineBlocker[];
};

export type NativeAssetProjection = {
  readonly workId: string;
  readonly assetId: string | null;
  readonly capturedAtMs: number;
  readonly previewUri: string | null;
  readonly previewStage: "PENDING" | "STAGED" | "UPLOADING" | "UPLOADED";
  readonly originalStage: "PENDING" | "STAGED" | "UPLOADING" | "UPLOADED";
  readonly blocker: EngineBlocker | null;
};

export interface CrewRollTransferPort {
  ensureDeviceIdentity(): Promise<NativeDeviceIdentity>;
  installDeviceSession(input: {
    deviceId: string;
    backgroundCredential: string;
    apiBaseUrl: string;
  }): Promise<void>;
  activateTrip(input: {
    tripId: string;
    memberId: string;
    startsAtMs: number;
    endsAtMs: number;
    releaseAtMs: number | null;
    keyEpoch: number;
    tripKeyEnvelope: string;
  }): Promise<void>;
  deactivateTrip(input: { tripId: string }): Promise<void>;
  setTransferPolicy(input: { paused: boolean; cellularAllowed: boolean }): Promise<void>;
  reconcileNow(): Promise<void>;
  retry(input: { workId: string }): Promise<void>;
  getSnapshot(): Promise<EngineSnapshot>;
  listAssets(input: { cursor: string | null; limit: number }): Promise<{
    items: readonly NativeAssetProjection[];
    nextCursor: string | null;
  }>;
}
```

- [ ] **Step 4: Write the failing config-plugin assertions**

Export pure `applyIosInfoPlist` and `applyAndroidManifest` helpers from the plugin and test them before connecting Expo mods:

```typescript
import {
  applyAndroidManifest,
  applyIosInfoPlist,
} from "./withCrewRollTransfer";

it("adds one iOS background-processing path without an extension", () => {
  const plist = applyIosInfoPlist({});
  expect(plist.BGTaskSchedulerPermittedIdentifiers).toEqual([
    "com.uankit53.airmesh.media-processing",
  ]);
  expect(plist.UIBackgroundModes).toEqual(["processing", "remote-notification"]);
  expect(JSON.stringify(plist)).not.toContain("com.apple.photos.background-upload");
});

it("adds version-scoped Android photo permission", () => {
  const manifest = applyAndroidManifest({ manifest: { "uses-permission": [] } });
  expect(manifest.manifest["uses-permission"]).toEqual(expect.arrayContaining([
    expect.objectContaining({ `$: { "android:name": "android.permission.READ_MEDIA_IMAGES" } }),
    expect.objectContaining({
      `$: {
        "android:name": "android.permission.READ_EXTERNAL_STORAGE",
        "android:maxSdkVersion": "32",
      },
    }),
  ]));
});
```

The completed introspected config must include:

- iOS `NSPhotoLibraryUsageDescription` and `NSPhotoLibraryAddUsageDescription`
- iOS `BGTaskSchedulerPermittedIdentifiers = ["com.uankit53.airmesh.media-processing"]`
- iOS `UIBackgroundModes = ["processing", "remote-notification"]`
- Android minimum SDK 30
- Android `READ_MEDIA_IMAGES`
- Android `READ_EXTERNAL_STORAGE` with maximum API 32
- no local-network permission and no PhotoKit upload extension target

- [ ] **Step 5: Implement the local module and plugin**

Use Expo Modules API `requireNativeModule("CrewRollTransfer")`. Both native shells return:

```json
{
  "revision": 0,
  "activeTripId": null,
  "paused": false,
  "counts": {
    "discovered": 0,
    "previewReady": 0,
    "originalsSaved": 0,
    "blocked": 0
  },
  "blockers": []
}
```

The plugin uses `withInfoPlist`, `withAndroidManifest`, and `expo-build-properties`. It must not create an iOS app-extension target.

- [ ] **Step 6: Verify clean native generation in the isolated execution worktree**

Run: `test ! -d ios && test ! -d android && npx expo prebuild --clean && npx expo config --type introspect`

Expected: the locked greenfield worktree has no tracked root native directories; prebuild succeeds, the module autolinks, identifiers remain unchanged, and plugin assertions pass. If a future branch contains tracked signing projects, stop before prebuild and preserve them byte-for-byte under `GOV-001`.

- [ ] **Step 7: Commit the reproducible module and configuration**

```bash
git add modules/crewroll-transfer src/shared/native app.json
git commit -m "feat: scaffold native transfer engine"
```

### Task 7: Implement Native State Machines and Durable Persistence

**Files:**
- Create: `modules/crewroll-transfer/ios/Domain/Models.swift`
- Create: `modules/crewroll-transfer/ios/Package.swift`
- Create: `modules/crewroll-transfer/ios/Domain/TransferStages.swift`
- Create: `modules/crewroll-transfer/ios/Domain/Ports.swift`
- Create: `modules/crewroll-transfer/ios/Persistence/TransferDatabase.swift`
- Create: `modules/crewroll-transfer/ios/Persistence/Migrations.swift`
- Create: `modules/crewroll-transfer/ios/Persistence/Records.swift`
- Create: `modules/crewroll-transfer/ios/Tests/PersistenceTests.swift`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/domain/Models.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/domain/TransferStages.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/domain/Ports.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/persistence/TransferDatabase.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/persistence/Entities.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/persistence/Daos.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/persistence/Migrations.kt`
- Create: `modules/crewroll-transfer/android/src/test/java/com/uankit53/crewroll/transfer/persistence/PersistenceTest.kt`

**Interfaces:**
- Produces repositories for `engine_settings`, `active_trip`, `library_checkpoint`, `asset_job`, `blob_job`, `delivery_job`, `saved_asset`, `command_outbox`, and `inbox_checkpoint`
- Enforces unique `(trip_id, source_dedupe_hmac)`, `(asset_local_id, variant)`, `delivery_id`, `asset_id` saves, and outbox `dedupe_key`

- [ ] **Step 1: Write failing monotonic-transition tests on both platforms**

Swift:

```swift
@Test func uploadedBlobCannotMoveBackToStaged() {
  #expect(throws: StageTransitionError.self) {
    try BlobStage.uploaded.advanced(to: .staged)
  }
}
```

Kotlin:

```kotlin
@Test
fun uploadedBlobCannotMoveBackToStaged() {
  assertFailsWith<StageTransitionException> {
    BlobStage.UPLOADED.advanceTo(BlobStage.STAGED)
  }
}
```

Create the Swift package harness with:

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CrewRollTransferCore",
  platforms: [.iOS(.v16)],
  products: [.library(name: "CrewRollTransferCore", targets: ["CrewRollTransferCore"])],
  dependencies: [
    .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),
    .package(url: "https://github.com/jedisct1/swift-sodium.git", from: "0.9.1"),
  ],
  targets: [
    .target(
      name: "CrewRollTransferCore",
      dependencies: [
        .product(name: "GRDB", package: "GRDB.swift"),
        .product(name: "Sodium", package: "swift-sodium"),
      ],
      path: ".",
      exclude: ["CrewRollTransferModule.swift", "CrewRollTransfer.podspec", "Tests"]
    ),
    .testTarget(
      name: "CrewRollTransferCoreTests",
      dependencies: ["CrewRollTransferCore"],
      path: "Tests"
    ),
  ]
)
```

- [ ] **Step 2: Run native unit tests and verify missing stage types**

Run after a clean prebuild:

```bash
swift test --package-path modules/crewroll-transfer/ios
./android/gradlew -p android :crewroll-transfer:testDebugUnitTest
```

Expected: both fail because `BlobStage` is absent.

- [ ] **Step 3: Implement the exact stages**

```text
AssetStage: DISCOVERED -> MATERIALIZED -> COMMITTED -> SOURCE_DONE
BlobStage: PENDING -> STAGED -> UPLOADING -> UPLOADED
DeliveryStage: READY -> DOWNLOADING -> VERIFIED -> SAVED_LOCALLY
CommandStage: PENDING -> ACKNOWLEDGED
SavedAssetStage: INTENT -> SAVED
```

`attempt_count`, `next_attempt_at_ms`, and `blocker_code` remain separate columns. Pausing modifies `engine_settings.paused` only.

Use this semantic schema in both GRDB and Room:

```sql
CREATE TABLE engine_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  cellular_allowed INTEGER NOT NULL CHECK (cellular_allowed IN (0, 1))
);

CREATE TABLE active_trip (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  trip_id TEXT NOT NULL UNIQUE,
  member_id TEXT NOT NULL,
  starts_at_ms INTEGER NOT NULL,
  ends_at_ms INTEGER NOT NULL,
  release_at_ms INTEGER,
  key_epoch INTEGER NOT NULL CHECK (key_epoch > 0)
);

CREATE TABLE library_checkpoint (
  platform_key TEXT PRIMARY KEY,
  library_version TEXT,
  opaque_change_token BLOB,
  generation INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE asset_job (
  local_id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  source_local_id TEXT NOT NULL,
  source_dedupe_hmac TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  stage TEXT NOT NULL,
  server_asset_id TEXT,
  blocker_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER,
  correlation_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (trip_id, source_dedupe_hmac)
);

CREATE TABLE blob_job (
  asset_local_id TEXT NOT NULL REFERENCES asset_job(local_id) ON DELETE CASCADE,
  variant TEXT NOT NULL CHECK (variant IN ('PREVIEW', 'ORIGINAL')),
  cipher_path TEXT,
  local_plaintext_sha256 TEXT,
  ciphertext_sha256 TEXT,
  plaintext_bytes INTEGER,
  ciphertext_bytes INTEGER,
  secretstream_header TEXT,
  stage TEXT NOT NULL,
  server_object_id TEXT,
  upload_session_id TEXT,
  transferred_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (asset_local_id, variant)
);

CREATE TABLE delivery_job (
  delivery_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  stage TEXT NOT NULL,
  cipher_path TEXT,
  plaintext_path TEXT,
  blocker_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER,
  correlation_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE saved_asset (
  asset_id TEXT PRIMARY KEY,
  system_asset_id TEXT NOT NULL UNIQUE,
  local_plaintext_sha256 TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('INTENT', 'SAVED')),
  saved_at_ms INTEGER
);

CREATE TABLE command_outbox (
  id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER,
  acknowledged_at_ms INTEGER
);

CREATE TABLE inbox_checkpoint (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cursor TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
```

Both `local_plaintext_sha256` columns are protected device-local verification state. Native serializers must exclude them from bridge snapshots, requests, receipts, logs, analytics, crash data, and push. The source pipeline may copy the digest only into the encrypted manifest; the recipient compares it only after authenticated decryption.

- [ ] **Step 4: Write failing duplicate and crash-reopen tests**

Insert the same source HMAC twice and expect the original row. Advance a blob, close the database, reopen it, and expect the same stage and byte count. Repeat for a delivery receipt and a system-library save.

- [ ] **Step 5: Implement GRDB and Room migrations**

Use schema version 1 with the nine tables listed in this task's Interfaces. Enable SQLite foreign keys and WAL. Keep transactions short and never hold one while reading photo bytes or doing network work.

Add Room runtime, compiler through KSP, `room-ktx`, and `androidx.work:work-runtime-ktx` to the local module. Resolve and commit the Gradle dependency lock so every developer and EAS build uses the reviewed versions.

- [ ] **Step 6: Run native persistence suites**

Expected: monotonic, uniqueness, migration, and crash-reopen tests pass on Swift and Kotlin.

- [ ] **Step 7: Commit persistence**

```bash
git add modules/crewroll-transfer/ios modules/crewroll-transfer/android
git commit -m "feat: add durable native transfer state"
```

### Task 8: Implement Device Identity and the E2EE Wire Format

**Files:**
- Consume only: `packages/contracts/crypto/vectors/`
- Consume only: `packages/contracts/crypto/protocol.ts`
- Create: `modules/crewroll-transfer/ios/Crypto/NativeKeyVault.swift`
- Create: `modules/crewroll-transfer/ios/Crypto/SecretStreamCipher.swift`
- Create: `modules/crewroll-transfer/ios/Crypto/Hashing.swift`
- Create: `modules/crewroll-transfer/ios/Tests/CryptoVectorTests.swift`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/crypto/NativeKeyVault.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/crypto/SecretStreamCipher.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/crypto/Hashing.kt`
- Create: `modules/crewroll-transfer/android/src/test/java/com/uankit53/crewroll/transfer/crypto/CryptoVectorTest.kt`

**Interfaces:**
- Produces: device signing public key and device encryption public key; private keys never cross the bridge
- Produces: 256 KiB authenticated frames using `crypto_secretstream_xchacha20poly1305`
- Produces: one random 32-byte content key per asset, wrapped by the active trip epoch key; variant keys are derived with libsodium `crypto_kdf_derive_from_key` using context `CRROLL01` and subkey IDs 1 for preview and 2 for original
- Authenticated metadata: protocol version, trip ID, asset idempotency key, variant, key epoch, MIME type

- [ ] **Step 1: Verify and consume the immutable upstream fixtures**

Run: `npm run test -w @crewroll/contracts -- crypto`

Expected: PASS and canonical fixtures cover fixed authenticated metadata plus plaintext lengths of 0, 1, 262144, and 262145 bytes. Swift and Kotlin tests read those committed bytes from `packages/contracts/crypto/vectors/`; they never generate, copy, or redefine their own oracle. Production code always uses secure random content keys and headers.

- [ ] **Step 2: Write failing cross-platform vector tests**

Each platform must decrypt every fixture, match plaintext SHA-256, and reject:

- one flipped ciphertext bit
- a missing final frame
- reversed frame order
- a duplicated middle frame
- authenticated metadata with a changed trip ID

- [ ] **Step 3: Run the vector suites**

Expected: FAIL because the key vault and cipher adapters are absent.

- [ ] **Step 4: Implement native key storage**

iOS creates a P-256 signing key for device authentication and stores the device X25519 secret plus trip epoch keys in Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Android creates a non-exportable P-256 signing key and AES-GCM wrapping key in Keystore, uses the wrapping key to protect the libsodium X25519 secret and trip epoch keys at rest, and prefers hardware-backed protection when available. Store trip epoch keys under `trip/<tripId>/epoch/<epoch>` and erase them when retention obligations finish.

- [ ] **Step 5: Implement bounded-memory secretstream**

The cipher accepts streams, buffers at most one 256 KiB frame plus authentication overhead, writes ciphertext to an app-private no-backup path, and returns:

```typescript
type EncryptedBlobDescriptor = {
  readonly plaintextBytes: number;
  readonly ciphertextBytes: number;
  readonly localPlaintextSha256: string;
  readonly ciphertextSha256: string;
  readonly secretstreamHeader: string;
  readonly ciphertextPath: string;
};
```

`localPlaintextSha256` is a native, device-local exactness value. Persist it only in the protected native ledger and place it inside the encrypted manifest before upload. Never expose it through the Expo bridge or send it as a plaintext API field, receipt field, HTTP header, log, analytic, crash context, push payload, or public database value.

- [ ] **Step 6: Run all vector tests**

Expected: Swift and Kotlin pass the same fixture and all corruption cases fail authentication.

- [ ] **Step 7: Commit crypto**

```bash
git diff --exit-code -- packages/contracts
git add modules/crewroll-transfer
git commit -m "feat: add native end-to-end encryption"
```

### Task 9: Implement Authentication and Device Provisioning

**Files:**
- Create: `src/features/auth/model.ts`
- Create: `src/features/auth/api.ts`
- Create: `src/features/auth/DeviceProvisioningService.ts`
- Create: `src/features/auth/DeviceProvisioningService.test.ts`
- Create: `src/features/auth/screens/SignInScreen.tsx`
- Create: `src/bootstrap/AppProviders.tsx`
- Modify: `app/_layout.tsx`

**Interfaces:**
- Consumes: `CrewRollTransferPort.ensureDeviceIdentity()` and `installDeviceSession()`
- Consumes: canonical `POST /v1/devices`
- Produces: `provisionCurrentDevice(): Promise<{ deviceId: string }>`

- [ ] **Step 1: Write the failing provisioning test**

```typescript
it("installs the background credential without returning it", async () => {
  native.ensureDeviceIdentity.mockResolvedValue(identity);
  api.registerDevice.mockResolvedValue({
    deviceId: "5a95305d-c558-4c79-b78c-a075be7bff84",
    backgroundCredential: "opaque-device-credential",
  });

  await expect(service.provisionCurrentDevice()).resolves.toEqual({
    deviceId: "5a95305d-c558-4c79-b78c-a075be7bff84",
  });
  expect(native.installDeviceSession).toHaveBeenCalledWith({
    deviceId: "5a95305d-c558-4c79-b78c-a075be7bff84",
    backgroundCredential: "opaque-device-credential",
    apiBaseUrl: "https://api.crewroll.app",
  });
});
```

- [ ] **Step 2: Run the test and verify service absence**

Run: `npm run test:ui -- src/features/auth/DeviceProvisioningService.test.ts`

Expected: FAIL because `DeviceProvisioningService` is absent.

- [ ] **Step 3: Implement sign-in and provisioning**

Use Clerk only for the user session. Register both native public keys through the API. Pass the returned background credential directly to the native module and discard it in JavaScript.

- [ ] **Step 4: Add logout erasure tests**

Logout must revoke the backend device session, call native credential/key erasure, clear TanStack Query, and route to sign-in. A revoked device cannot activate a trip.

- [ ] **Step 5: Run auth tests and commit**

```bash
npm run test:ui -- src/features/auth
git add src/features/auth src/bootstrap app/_layout.tsx
git commit -m "feat: provision secure CrewRoll devices"
```

### Task 10: Implement Create, Join, Start, and Native Trip Activation

**Files:**
- Create: `src/features/trips/model.ts`
- Create: `src/features/trips/api.ts`
- Create: `src/features/trips/tripQueries.ts`
- Create: `src/features/trips/TripActivationService.ts`
- Create: `src/features/trips/TripActivationService.test.ts`
- Create: `src/features/trips/components/MemberList.tsx`
- Create: `app/trips/create.tsx`
- Create: `app/trips/join.tsx`
- Create: `app/trips/[tripId]/index.tsx`
- Create: `app/trips/[tripId]/invite.tsx`

**Interfaces:**
- Consumes: trip API and `CrewRollTransferPort.activateTrip()`
- Produces one active native trip only after the server returns membership, dates, key epoch, and trip-key envelope

- [ ] **Step 1: Write failing activation-order tests**

```typescript
it("activates native discovery only after start succeeds", async () => {
  api.startTrip.mockResolvedValue(activeTrip);
  await service.start("trip-1");
  expect(api.startTrip.mock.invocationCallOrder[0])
    .toBeLessThan(native.activateTrip.mock.invocationCallOrder[0]);
  expect(native.activateTrip).toHaveBeenCalledWith({
    tripId: activeTrip.id,
    memberId: activeTrip.memberId,
    startsAtMs: activeTrip.startsAtMs,
    endsAtMs: activeTrip.endsAtMs,
    releaseAtMs: null,
    keyEpoch: 1,
    tripKeyEnvelope: activeTrip.tripKeyEnvelope,
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test:ui -- src/features/trips/TripActivationService.test.ts`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Implement the immediate-release two-user flow**

Create and join use user-authenticated API calls. Start returns a frozen recipient set and envelope. Do not add schedule controls in this task. The server remains authoritative for 10-member and one-active-trip constraints.

- [ ] **Step 4: Test rejected starts**

Verify native activation is not called for `409 ACTIVE_TRIP_EXISTS`, `409 TRIP_FULL`, revoked permission, or missing key envelope.

- [ ] **Step 5: Run route and service tests, then commit**

```bash
npm run test:ui -- src/features/trips
git add src/features/trips app/trips
git commit -m "feat: add trip creation and activation"
```

### Task 11: Implement iOS Photo Discovery and Persistent Reconciliation

**Files:**
- Create: `modules/crewroll-transfer/ios/Photos/PhotoLibraryMonitor.swift`
- Create: `modules/crewroll-transfer/ios/Photos/PhotoReconciler.swift`
- Create: `modules/crewroll-transfer/ios/Photos/PhotoMaterializer.swift`
- Create: `modules/crewroll-transfer/ios/Background/BackgroundTaskRegistrar.swift`
- Create: `modules/crewroll-transfer/ios/Engine/TransferEngine.swift`
- Create: `modules/crewroll-transfer/ios/Tests/PhotoReconcilerTests.swift`

**Interfaces:**
- Consumes: `PHPhotoLibrary.currentChangeToken` and `fetchPersistentChanges(since:)`
- Produces idempotent `asset_job` rows for new image resources captured after trip activation
- Excludes screenshots, known download/import classes, and CrewRoll-saved local identifiers

- [ ] **Step 1: Write failing reconciliation tests against a fake PhotoKit port**

Cover:

- activation stores the current token without importing history
- one new image creates one job
- repeated change callbacks create no duplicate
- an expired token performs a full scan bounded by trip start
- a CrewRoll-saved local identifier is excluded
- an image removed before materialization becomes `SOURCE_MISSING`

- [ ] **Step 2: Run Swift tests**

Run: `swift test --package-path modules/crewroll-transfer/ios --filter PhotoReconcilerTests`

Expected: FAIL because `PhotoReconciler` is absent.

- [ ] **Step 3: Implement persistent reconciliation**

The observer is only a wake hint. Every wake calls the same transaction-safe reconciler, and the change token advances only after all discovered jobs are durably inserted.

- [ ] **Step 4: Register opportunistic background processing**

Register `com.uankit53.airmesh.media-processing` before launch completes. Its expiration handler cancels the current scan, leaves uncommitted tokens unchanged, resubmits the request, and marks the task complete accurately.

- [ ] **Step 5: Add a physical-device discovery test**

On a real iPhone:

1. Activate a trip.
2. Background CrewRoll without force-quitting.
3. Take one stock-camera photo.
4. Reopen CrewRoll.
5. Assert one durable job within five seconds and no prior library photo.

- [ ] **Step 6: Run tests and commit**

```bash
swift test --package-path modules/crewroll-transfer/ios
git add modules/crewroll-transfer/ios
git commit -m "feat: discover iOS trip photos durably"
```

### Task 12: Implement the iOS Preview-First Encrypted Source Pipeline

**Files:**
- Create: `modules/crewroll-transfer/ios/Engine/SourcePipeline.swift`
- Create: `modules/crewroll-transfer/ios/Network/DeviceApiClient.swift`
- Create: `modules/crewroll-transfer/ios/Network/BackgroundSessionCoordinator.swift`
- Create: `modules/crewroll-transfer/ios/Network/BackgroundSessionDelegate.swift`
- Create: `modules/crewroll-transfer/ios/Tests/SourcePipelineTests.swift`
- Create: `modules/crewroll-transfer/ios/Tests/BackgroundSessionTests.swift`

**Interfaces:**
- Consumes: discovered asset, trip epoch key, native device credential, upload-session API
- Produces encrypted preview commit before original completion
- Persists ciphertext only; source plaintext is streamed from PhotoKit

- [ ] **Step 1: Write failing preview-order and idempotency tests**

Using fake photo, cipher, API, and transfer ports, assert:

- preview is staged and uploaded before original upload begins
- repeating the worker uses the same idempotency key
- a signed URL expiring during retry is refreshed
- commit repeats return the same server asset
- source removal becomes a visible terminal blocker

- [ ] **Step 2: Run Swift source-pipeline tests**

Expected: FAIL because `SourcePipeline` is absent.

- [ ] **Step 3: Implement preview generation and encryption**

Generate a maximum 1600-pixel JPEG preview at quality 0.78 with orientation applied and location metadata omitted. Encrypt preview and original independently. Derive the server idempotency key as HMAC-SHA256 of trip ID plus source local identifier using the native source-ID key.

- [ ] **Step 4: Implement background upload coordination**

Use one fixed background-session identifier `com.uankit53.airmesh.transfer.upload`, `waitsForConnectivity = true`, and file-backed upload tasks. Store URLSession task identifiers in `blob_job` before resuming them. The delegate updates durable bytes and completion results.

- [ ] **Step 5: Test suspension and force-quit truth**

Verify:

- a staged background upload completes after normal suspension
- system termination reconnects the same session identifier and reconciles tasks
- user force-quit cancels work; after explicit relaunch, the native database resumes from the last durable stage

- [ ] **Step 6: Run tests and commit**

```bash
swift test --package-path modules/crewroll-transfer/ios
git add modules/crewroll-transfer/ios
git commit -m "feat: upload encrypted iOS photos"
```

### Task 13: Implement Android MediaStore Discovery and Generation Reconciliation

**Files:**
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/photos/MediaStoreMonitor.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/photos/MediaStoreReconciler.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/photos/PhotoMaterializer.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/work/MediaChangeJobService.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/work/ReconcileWorker.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/work/WorkScheduler.kt`
- Create: `modules/crewroll-transfer/android/src/test/java/com/uankit53/crewroll/transfer/photos/MediaStoreReconcilerTest.kt`
- Create: `modules/crewroll-transfer/android/src/androidTest/java/com/uankit53/crewroll/transfer/photos/MediaStoreIntegrationTest.kt`

**Interfaces:**
- Consumes: MediaStore version and per-volume generation
- Produces idempotent image jobs for generations after activation
- Uses `TriggerContentUri` and `ContentObserver` as wake hints only

- [ ] **Step 1: Write failing generation tests**

Cover:

- activation stores version/generation without importing history
- generation increases create exactly one job
- duplicate trigger produces no duplicate
- version change forces a bounded full scan
- `Pictures/CrewRoll/` and saved MediaStore IDs are excluded
- screenshots and known download paths are excluded

- [ ] **Step 2: Run Android unit tests**

Run: `./android/gradlew -p android :crewroll-transfer:testDebugUnitTest`

Expected: FAIL because `MediaStoreReconciler` is absent.

- [ ] **Step 3: Implement generation reconciliation**

Query only images with `GENERATION_ADDED` or `GENERATION_MODIFIED` greater than the checkpoint. Commit the new checkpoint in the same database transaction that inserts all corresponding jobs.

- [ ] **Step 4: Implement durable wake scheduling**

Register a private, non-exported `JobService` on `MediaStore.Images.Media.EXTERNAL_CONTENT_URI` with descendant notifications. The service enqueues unique `crewroll-media-reconcile` WorkManager work and re-registers its content trigger.

- [ ] **Step 5: Run API 30 and current-API instrumented tests**

Expected: a stock-camera image produces one job after foreground, background, process death, and reboot test cases.

- [ ] **Step 6: Commit Android discovery**

```bash
git add modules/crewroll-transfer/android
git commit -m "feat: discover Android trip photos durably"
```

### Task 14: Implement the Android Preview-First Encrypted Source Pipeline

**Files:**
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/engine/TransferEngine.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/engine/SourcePipeline.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/network/DeviceApiClient.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/work/SourceTransferWorker.kt`
- Create: `modules/crewroll-transfer/android/src/test/java/com/uankit53/crewroll/transfer/engine/SourcePipelineTest.kt`
- Create: `modules/crewroll-transfer/android/src/androidTest/java/com/uankit53/crewroll/transfer/work/SourceTransferWorkerTest.kt`

**Interfaces:**
- Matches the iOS preview, encryption, hash, idempotency, and commit contract
- Uses OkHttp file request bodies and unique WorkManager work

- [ ] **Step 1: Port the shared source-pipeline fixtures into failing Kotlin tests**

Assert preview-first order, exact source hash, URL refresh, idempotent commit, process restart, and no plaintext source file.

- [ ] **Step 2: Run Android tests and verify failure**

Expected: FAIL because `SourcePipeline` and `SourceTransferWorker` are absent.

- [ ] **Step 3: Implement native preview and encryption**

Downsample through `ImageDecoder` or `BitmapFactory` without decoding the full-resolution bitmap. Apply EXIF orientation, emit the same 1600-pixel/0.78 JPEG policy, and encrypt through the shared secretstream frame contract.

- [ ] **Step 4: Implement WorkManager and OkHttp transfer**

Use unique work name `source-transfer/<assetLocalId>`, exponential backoff, connected-network constraint, and a foreground notification only when Android requires a long-running worker. The database remains authoritative if WorkManager redelivers.

- [ ] **Step 5: Run unit and instrumented suites**

Expected: all shared fixtures pass on iOS and Android with matching hashes and stage order.

- [ ] **Step 6: Commit Android source transfer**

```bash
git add modules/crewroll-transfer/android
git commit -m "feat: upload encrypted Android photos"
```

### Task 15: Implement iOS Inbox Sync, Download, Verify, and Exact Save

**Files:**
- Create: `modules/crewroll-transfer/ios/Engine/DeliveryPipeline.swift`
- Create: `modules/crewroll-transfer/ios/Photos/PhotoSaver.swift`
- Create: `modules/crewroll-transfer/ios/Engine/SnapshotBuilder.swift`
- Create: `modules/crewroll-transfer/ios/Tests/DeliveryPipelineTests.swift`
- Create: `modules/crewroll-transfer/ios/Tests/PhotoSaverTests.swift`

**Interfaces:**
- Consumes ordered `GET /v1/sync` cursor pages and recipient-scoped signed downloads
- Produces exactly one system-library asset and durable `SAVED_LOCALLY` receipt
- Creates/uses a `CrewRoll • <Trip Name>` album to identify received media

- [ ] **Step 1: Write failing delivery tests**

Assert:

- inbox cursor advances only after every event is persisted
- preview download is scheduled before original
- ciphertext corruption never reaches PhotoKit
- a verified original saves exactly once across retry/restart
- storage-full leaves `STORAGE_FULL` and retries after space is available
- receipt remains in `command_outbox` until acknowledged

- [ ] **Step 2: Run Swift delivery tests**

Expected: FAIL because delivery pipeline and saver are absent.

- [ ] **Step 3: Implement cursor sync and download**

Use `com.uankit53.airmesh.transfer.download` for the background download session. Download to an app-private ciphertext file, decrypt to a file protected with `completeUntilFirstUserAuthentication`, verify plaintext SHA-256, and only then call PhotoKit.

- [ ] **Step 4: Implement exactly-once save**

Create the PhotoKit asset and add it to the CrewRoll trip album in one change request. Obtain the creation request's local identifier inside the change block and persist the `saved_asset` row in `INTENT` state before the block returns. On restart, resolve that identifier in PhotoKit before creating another asset; a missing identifier clears the failed intent, while an existing identifier advances the row to `SAVED`. Delete plaintext immediately after PhotoKit reports success.

- [ ] **Step 5: Run tests and commit**

```bash
swift test --package-path modules/crewroll-transfer/ios
git add modules/crewroll-transfer/ios
git commit -m "feat: save CrewRoll deliveries on iOS"
```

### Task 16: Implement Android Inbox Sync, Download, Verify, and Exact Save

**Files:**
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/engine/DeliveryPipeline.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/engine/SnapshotBuilder.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/photos/PhotoSaver.kt`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/work/DeliveryWorker.kt`
- Create: `modules/crewroll-transfer/android/src/test/java/com/uankit53/crewroll/transfer/engine/DeliveryPipelineTest.kt`
- Create: `modules/crewroll-transfer/android/src/androidTest/java/com/uankit53/crewroll/transfer/photos/PhotoSaverTest.kt`

**Interfaces:**
- Matches Task 15's cursor, priority, verification, dedupe, and receipt behavior
- Saves through MediaStore `IS_PENDING` under `Pictures/CrewRoll/<trip-name>/`

- [ ] **Step 1: Add failing Kotlin delivery fixtures**

Run the same corrupted, duplicate, restart, low-storage, and outbox cases as iOS.

- [ ] **Step 2: Run Android tests**

Expected: FAIL because delivery worker and saver are absent.

- [ ] **Step 3: Implement sync and priority lanes**

Use separate unique work chains for preview and original delivery. Bound concurrent original downloads to two and allow previews to pass originals. Persist the next cursor only after the event page is inserted transactionally.

- [ ] **Step 4: Implement exact MediaStore save**

Insert with `IS_PENDING = 1`, immediately persist the returned content URI in `saved_asset` with `INTENT` state, stream verified plaintext, set `IS_PENDING = 0`, advance the row to `SAVED`, and delete the private plaintext file. A restart resolves an `INTENT` URI before inserting; it resumes a valid pending row or removes an abandoned row, so it never creates a second visible asset.

- [ ] **Step 5: Run tests and commit**

```bash
./android/gradlew -p android :crewroll-transfer:testDebugUnitTest :app:connectedDebugAndroidTest
git add modules/crewroll-transfer/android
git commit -m "feat: save CrewRoll deliveries on Android"
```

### Task 17: Add Push Wake Hints Without Making Push Durable State

**Files:**
- Create: `src/features/auth/pushRegistration.ts`
- Create: `src/features/auth/pushRegistration.test.ts`
- Create: `src/features/transfer/pushWakeTask.ts`
- Create: `src/features/transfer/pushWakeTask.test.ts`
- Create: `src/bootstrap/bootstrap.ts`
- Modify: `src/features/auth/DeviceProvisioningService.ts`
- Modify: `app.json`

**Interfaces:**
- Consumes: native APNs/FCM device token from `expo-notifications`
- Produces: native push-token rotation through `POST /v1/devices/{deviceId}/push-token`
- Produces: background task `crewroll-push-wake` that calls `reconcileNow()` and stores no delivery state

- [ ] **Step 1: Write a failing push-wake test**

```typescript
it("uses a delivery notification only to start durable reconciliation", async () => {
  await handlePushWake(
    { data: { kind: "DELIVERY_AVAILABLE" } },
    native,
  );
  expect(native.reconcileNow).toHaveBeenCalledTimes(1);
});

it("ignores media identifiers and URLs in a malformed payload", async () => {
  await handlePushWake(
    { data: { kind: "DELIVERY_AVAILABLE", objectUrl: "https://object.example/raw" } },
    native,
  );
  expect(native.reconcileNow).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the wake tests**

Run: `npm run test:ui -- src/features/transfer/pushWakeTask.test.ts`

Expected: FAIL because `handlePushWake` is absent.

- [ ] **Step 3: Implement native-token registration**

Request notification permission after device provisioning, call `Notifications.getDevicePushTokenAsync()`, and send only platform plus opaque native token to the device endpoint. Never send trip ID, asset ID, filename, hash, signed URL, or key material in a push token record.

- [ ] **Step 4: Register one background wake task**

Register `crewroll-push-wake` at module scope before React renders. Accept only:

```typescript
type DeliveryWakePayload = {
  readonly kind: "DELIVERY_AVAILABLE";
};
```

The task calls `CrewRollTransfer.reconcileNow()` and returns. Foreground notification listeners call the same function. Duplicate notifications are harmless because inbox cursors and native uniqueness constraints are authoritative.

- [ ] **Step 5: Add config and denial tests**

Verify notification denial leaves trip transfer functional through foreground and scheduled reconciliation. Verify no UI claims that notifications guarantee delivery.

- [ ] **Step 6: Run tests and commit**

```bash
npm run test:ui -- src/features/transfer
git add src/features/auth src/features/transfer src/bootstrap app.json
git commit -m "feat: add delivery wake notifications"
```

### Task 18: Connect Durable Transfer Projections to the React Native UI

**Files:**
- Create: `src/features/transfer/transferQueries.ts`
- Create: `src/features/transfer/transferViewModel.ts`
- Create: `src/features/transfer/transferViewModel.test.ts`
- Create: `src/features/transfer/components/TripProgress.tsx`
- Create: `src/features/transfer/components/AssetGrid.tsx`
- Create: `src/features/transfer/components/TransferBlockerCard.tsx`
- Create: `src/features/transfer/components/TransferControls.tsx`
- Modify: `app/trips/[tripId]/index.tsx`

**Interfaces:**
- Consumes native `engineInvalidated` revisions and durable snapshot/list queries
- Produces pause/resume and explicit retry commands
- Never optimistically advances transfer stage

- [ ] **Step 1: Write failing projection tests**

```typescript
it("shows completion only from saved-local counts", () => {
  const view = toTripProgress({
    expectedDeliveries: 9,
    savedLocally: 8,
    previewReady: 9,
    blocked: 1,
  });
  expect(view.complete).toBe(false);
  expect(view.label).toBe("8 of 9 originals saved");
});
```

- [ ] **Step 2: Run transfer UI tests**

Expected: FAIL because `toTripProgress` is absent.

- [ ] **Step 3: Implement invalidation-driven queries**

Subscribe once in `AppProviders`. On a higher revision, invalidate `["native-engine"]` and current asset pages. Throttle visual byte progress to four updates per second; never drop terminal state invalidations.

- [ ] **Step 4: Implement the trip progress UI**

Render preview/original distinction, member completion, permission/storage/auth blockers, pause/resume, and retry. Use FlashList for asset projections and `expo-image` for encrypted-preview cache output supplied by the native module.

- [ ] **Step 5: Test restart and blocker recovery**

Remount the provider with native state already populated. Verify progress renders without replaying events, pause survives restart, and a cleared blocker disappears after the next durable revision.

- [ ] **Step 6: Run tests and commit**

```bash
npm run test:ui -- src/features/transfer
git add src/features/transfer app/trips src/bootstrap
git commit -m "feat: show durable trip transfer progress"
```

### Task 19: Implement Completion Reconciliation and Honest Product States

**Files:**
- Create: `src/features/reconciliation/model.ts`
- Create: `src/features/reconciliation/reconciliationQueries.ts`
- Create: `src/features/reconciliation/ReconciliationMatrix.tsx`
- Create: `src/features/reconciliation/ReconciliationMatrix.test.tsx`
- Create: `app/trips/[tripId]/reconciliation.tsx`
- Create: `app/onboarding.tsx`

**Interfaces:**
- Consumes server asset-by-member delivery matrix
- Produces `COMPLETE` only when every required cell is `SAVED_LOCALLY`
- Shows exact device/member blocker for all incomplete cells

- [ ] **Step 1: Write the failing completion rule**

```typescript
it("refuses completion when one device has only the preview", () => {
  const result = reconcileTrip({
    cells: [
      { memberId: "member-a", assetId: "asset-1", state: "SAVED_LOCALLY" },
      { memberId: "member-b", assetId: "asset-1", state: "PREVIEW_SAVED" },
    ],
  });
  expect(result.status).toBe("ENDING");
  expect(result.missing).toEqual([
    { memberId: "member-b", assetId: "asset-1", state: "PREVIEW_SAVED" },
  ]);
});
```

- [ ] **Step 2: Run the reconciliation test**

Expected: FAIL because `reconcileTrip` is absent.

- [ ] **Step 3: Implement reconciliation and terminal states**

Support exactly `ENDING`, `COMPLETE`, and `INCOMPLETE_EXPIRED` in this screen. Never translate an upload-complete state into trip complete.

- [ ] **Step 4: Add honest permission and force-quit copy**

The onboarding screen must state:

> CrewRoll shares new photos added while a trip is active. Keep full photo access enabled. If you force-close CrewRoll, sharing pauses until you open it again.

Also state that known screenshots, downloads, and CrewRoll-received photos are excluded, but no platform can prove camera origin for every asset.

- [ ] **Step 5: Run tests and commit**

```bash
npm run test:ui -- src/features/reconciliation
git add src/features/reconciliation app
git commit -m "feat: add trip completion reconciliation"
```

### Task 20: Add Privacy-Safe Transfer Observability

**Files:**
- Create: `src/shared/observability/eventAllowlist.ts`
- Create: `src/shared/observability/eventAllowlist.test.ts`
- Create: `src/shared/observability/sentry.ts`
- Create: `modules/crewroll-transfer/ios/Engine/TransferTelemetry.swift`
- Create: `modules/crewroll-transfer/ios/Tests/TransferTelemetryTests.swift`
- Create: `modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/engine/TransferTelemetry.kt`
- Create: `modules/crewroll-transfer/android/src/test/java/com/uankit53/crewroll/transfer/engine/TransferTelemetryTest.kt`
- Modify: `src/bootstrap/AppProviders.tsx`
- Modify: `package.json`

**Interfaces:**
- Produces stage timings for discovered, staged, preview uploaded, original uploaded, inbox ready, download verified, library saved, and receipt accepted
- Produces opaque correlation IDs shared across native HTTP requests and backend logs
- Rejects filenames, source identifiers, object URLs, hashes, key material, and photo metadata from analytics/crash contexts

- [ ] **Step 1: Write a failing analytics allowlist test**

```typescript
import { sanitizeTransferEvent } from "./eventAllowlist";

it("keeps timing dimensions and rejects media data", () => {
  expect(sanitizeTransferEvent({
    name: "original_saved",
    durationMs: 842,
    platform: "ios",
    filename: "IMG_0042.HEIC",
    plaintextSha256: "a".repeat(64),
    objectUrl: "https://bucket.example/signed",
  })).toEqual({
    name: "original_saved",
    durationMs: 842,
    platform: "ios",
  });
});
```

- [ ] **Step 2: Run observability tests**

Run: `npm run test:ui -- src/shared/observability/eventAllowlist.test.ts`

Expected: FAIL because the sanitizer is absent.

- [ ] **Step 3: Install and initialize Sentry**

Run: `npx expo install @sentry/react-native`

Initialize Sentry before route rendering with request bodies, screenshots, view hierarchy attachment, and default PII disabled. Apply the same allowlist to breadcrumbs and native error extras.

- [ ] **Step 4: Implement native stage telemetry**

Generate a random correlation ID when an asset or delivery job is inserted. Persist it with the job and send it as `X-Correlation-Id`. Native telemetry records stage name, elapsed milliseconds, attempt count, network class, platform, app state, and structured error code only.

- [ ] **Step 5: Test forbidden-field removal on all runtimes**

Swift and Kotlin tests submit dictionaries containing filename, source local ID, hashes, signed URL, location, and key fields. Expected output contains none of them. JavaScript tests exercise the same forbidden set.

- [ ] **Step 6: Run all observability tests and commit**

```bash
npm run test:ui -- src/shared/observability
swift test --package-path modules/crewroll-transfer/ios --filter TransferTelemetryTests
./android/gradlew -p android :crewroll-transfer:testDebugUnitTest
git add src/shared/observability src/bootstrap modules/crewroll-transfer package.json package-lock.json
git commit -m "feat: add private transfer observability"
```

### Task 21: Prove the Physical-Device Vertical Slice and Release Identity

**Files:**
- Create: `tests/maestro/photo-vertical-slice.yaml`
- Create: `tests/maestro/restart-recovery.yaml`
- Create: `tests/maestro/low-storage-recovery.yaml`
- Create: `docs/acceptance/photo-vertical-slice.md`
- Create: `docs/runbooks/crewroll-transfer.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces a release gate for one iOS and one Android physical device
- Verifies built artifacts retain existing store identities

- [ ] **Step 1: Write the failing Maestro journey**

The flow must:

1. Sign in on two physical devices.
2. Create and join one immediate trip.
3. Grant full photo permission.
4. Start the trip.
5. Background CrewRoll on the source device.
6. Capture one photo with the stock camera.
7. Observe a preview on the recipient.
8. Observe the exact original once in the recipient library.
9. Confirm `SAVED_LOCALLY` in reconciliation.
10. Confirm temporary-object deletion through the test API.

- [ ] **Step 2: Run the journey before release configuration**

Run: `maestro test tests/maestro/photo-vertical-slice.yaml`

Expected: FAIL until real-device endpoints, credentials, and builds are connected.

- [ ] **Step 3: Add restart, offline, and low-storage cases**

Required cases:

- source app process terminated after ciphertext staging
- recipient offline for 20 minutes
- duplicate push and duplicate sync page
- recipient storage full, then space freed
- iOS user force-quit, explicit relaunch, reconciliation resumes
- Android Settings force-stop, explicit relaunch, reconciliation resumes

- [ ] **Step 4: Run all automated gates**

```bash
npm run check
node tools/verify-app-identity.mjs .
npx expo-doctor
npm run verify:bundle
test ! -d ios && test ! -d android && npx expo prebuild --clean
swift test --package-path modules/crewroll-transfer/ios
./android/gradlew -p android :crewroll-transfer:testDebugUnitTest
```

Expected: every command exits zero.

- [ ] **Step 5: Build signed previews using the preserved EAS project**

```bash
npx eas-cli@latest build --profile preview --platform ios
npx eas-cli@latest build --profile preview --platform android
```

Expected: both builds belong to project `fe1de141-5c42-4250-9c1f-f7313845dc8e` and contain package identifier `com.uankit53.airmesh`.

- [ ] **Step 6: Run the multi-device acceptance suite**

Run all three Maestro flows on representative current iOS and Android devices. Record capture-to-preview and capture-to-original timings in `docs/acceptance/photo-vertical-slice.md`.

Acceptance:

- preview p50 below 3 seconds and p95 below 8 seconds on healthy Wi-Fi/5G
- 5 MB original p50 below 10 seconds and p95 below 30 seconds
- exact plaintext SHA-256 on recipient
- exactly one recipient library asset
- durable receipt after restart
- object deleted after all required receipts
- no completion state while a required receipt is missing

- [ ] **Step 7: Commit the verified release gate**

```bash
git add tests/maestro docs/acceptance docs/runbooks .github/workflows/ci.yml
git commit -m "test: gate CrewRoll photo delivery on devices"
```

## Execution Checkpoints

Stop for reviewer approval after Tasks 2, 4, 8, 12, 14, 16, and 21. These are the boundaries where identity, contracts, cryptography, each source platform, each recipient platform, and the complete user promise become independently rejectable.

The first product milestone is not a screen or successful upload. It is Task 21's two-device proof: one stock-camera photo enters the native outbox, is encrypted, reaches the recipient, verifies byte-for-byte, saves exactly once, emits `SAVED_LOCALLY`, and is purged from temporary storage.
