import { createHash } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  ApproveJoinRequestBodySchema,
  CreateJoinRequestBodySchema,
  CreateTripBodySchema,
  CreateTripOutcomeBodySchema,
  CreateTripOutcomeResponseSchema,
  DeviceRegistrationHeadersSchema,
  DeviceResponseSchema,
  MembershipResponseSchema,
  MobileCommandHeadersSchema,
  MobileQueryHeadersSchema,
  ProblemDetailsSchema,
  RegisterDeviceBodySchema,
  SetTripReadinessBodySchema,
  StartTripBodySchema,
  TripIdSchema,
  TripResponseSchema,
  installCrewRollFormats,
  type ApproveJoinRequestBody,
  type CreateJoinRequestBody,
  type CreateTripBody,
  type DeviceResponse,
  type MembershipResponse,
  type ProblemCode,
  type ProblemDetails,
  type RegisterDeviceBody,
  type SetTripReadinessBody,
  type StartTripBody,
  type TripResponse,
} from "@crewroll/contracts";
import { validRegisterDeviceBody } from "@crewroll/contracts/fixtures/http";
import { FormatRegistry, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sql, type Kysely } from "kysely";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createApiRuntime } from "../../services/control-plane/src/api/apiRuntime.js";
import type { ApiRuntimeFactories } from "../../services/control-plane/src/api/apiRuntime.js";
import { productionApiFactories } from "../../services/control-plane/src/api/productionApiFactories.js";
import { buildApp } from "../../services/control-plane/src/app/buildApp.js";
import { loadEnvironment } from "../../services/control-plane/src/config/env.js";
import type { Database } from "../../services/control-plane/src/db/schema/tables.js";
import type {
  TripTransaction,
  TripUnitOfWork,
} from "../../services/control-plane/src/modules/trips/ports/tripUnitOfWork.js";
import {
  createClerkJwtKey,
  signClerkJwt,
  type ClerkJwtKey,
} from "../../services/control-plane/test/support/clerkJwt.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import type { PostgresTestContext } from "./support/postgres.js";
import {
  resolveExplicitExternalPostgresUrl,
  startMigratedPostgres,
  truncateIdentityTripTables,
} from "./support/postgres.js";

installCrewRollFormats(FormatRegistry);

const AUTHORIZED_PARTY = "http://native.crewroll.test";
const BACKGROUND_HMAC_KEY = Buffer.alloc(32, 0xa5).toString("base64");
const OWNER_ENVELOPE = Buffer.alloc(148, 0x41).toString("base64");
const MEMBER_ENVELOPE = Buffer.alloc(148, 0x42).toString("base64");
const THIRD_ENVELOPE = Buffer.alloc(148, 0x43).toString("base64");
const OWNER_E2EE_KEY = Buffer.alloc(32, 0x21).toString("base64");
const MEMBER_E2EE_KEY = Buffer.alloc(32, 0x22).toString("base64");
const THIRD_E2EE_KEY = Buffer.alloc(32, 0x23).toString("base64");
const FIXED_CLOCK = new Date(Math.floor(Date.now() / 1_000) * 1_000);
const ONE_DAY_MS = 86_400_000;

type HttpMethod = "DELETE" | "GET" | "POST" | "PUT";
type TestApp = ReturnType<typeof buildApp>;

interface JsonRequest<Schema extends TSchema> {
  readonly app: TestApp;
  readonly body?: unknown;
  readonly bodySchema?: TSchema;
  readonly expectedStatus: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly headersSchema: TSchema;
  readonly method: HttpMethod;
  readonly responseSchema: Schema;
  readonly url: string;
}

interface EmptyRequest {
  readonly app: TestApp;
  readonly expectedStatus: 204;
  readonly headers: Readonly<Record<string, string>>;
  readonly headersSchema: TSchema;
  readonly method: "DELETE";
  readonly url: string;
}

interface RouteActor {
  readonly app: TestApp;
  readonly authorization: string;
  readonly deviceId: string;
}

interface RegisteredAccount {
  readonly authorization: string;
  readonly device: DeviceResponse;
  readonly subject: string;
}

interface RouteRuntime {
  readonly app: TestApp;
  close(): Promise<void>;
}

interface RuntimeOptions {
  readonly decorateTripUnitOfWork?: (
    unitOfWork: TripUnitOfWork,
  ) => TripUnitOfWork;
}

interface LocalClerkJwks {
  readonly issuer: string;
  readonly requests: () => number;
  sign(subject: string): Promise<string>;
  stop(): Promise<void>;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assertContract(schema: TSchema, value: unknown, label: string): void {
  expect(Value.Check(schema, value), `${label} violates shared contracts`).toBe(
    true,
  );
}

async function contractJson<Schema extends TSchema>({
  app,
  body,
  bodySchema,
  expectedStatus,
  headers,
  headersSchema,
  method,
  responseSchema,
  url,
}: JsonRequest<Schema>): Promise<Static<Schema>> {
  assertContract(headersSchema, headers, `${method} ${url} headers`);
  if (bodySchema !== undefined) {
    assertContract(bodySchema, body, `${method} ${url} body`);
  }
  const response = await app.inject(
    body === undefined
      ? { headers: { ...headers }, method, url }
      : { headers: { ...headers }, method, payload: body as object, url },
  );
  expect(response.statusCode).toBe(expectedStatus);
  const payload: unknown = response.json();
  assertContract(responseSchema, payload, `${method} ${url} response`);
  return payload as Static<Schema>;
}

async function contractEmpty({
  app,
  expectedStatus,
  headers,
  headersSchema,
  method,
  url,
}: EmptyRequest): Promise<void> {
  assertContract(headersSchema, headers, `${method} ${url} headers`);
  const response = await app.inject({ headers, method, url });
  expect(response.statusCode).toBe(expectedStatus);
  expect(response.payload).toBe("");
}

function commandHeaders(
  actor: RouteActor,
  idempotencyKey: string,
): Readonly<Record<string, string>> {
  return {
    authorization: actor.authorization,
    "idempotency-key": idempotencyKey,
    "x-crewroll-device-id": actor.deviceId,
  };
}

function queryHeaders(actor: RouteActor): Readonly<Record<string, string>> {
  return {
    authorization: actor.authorization,
    "x-crewroll-device-id": actor.deviceId,
  };
}

function actorOn(
  runtime: RouteRuntime,
  account: RegisteredAccount,
): RouteActor {
  return {
    app: runtime.app,
    authorization: account.authorization,
    deviceId: account.device.deviceId,
  };
}

async function registerDevice(
  app: TestApp,
  authorization: string,
  body: RegisterDeviceBody,
  idempotencyKey: string,
): Promise<DeviceResponse> {
  return contractJson({
    app,
    body,
    bodySchema: RegisterDeviceBodySchema,
    expectedStatus: 201,
    headers: { authorization, "idempotency-key": idempotencyKey },
    headersSchema: DeviceRegistrationHeadersSchema,
    method: "POST",
    responseSchema: DeviceResponseSchema,
    url: "/v1/devices",
  });
}

async function createTrip(
  actor: RouteActor,
  body: CreateTripBody,
  idempotencyKey: string,
): Promise<TripResponse> {
  return contractJson({
    app: actor.app,
    body,
    bodySchema: CreateTripBodySchema,
    expectedStatus: 201,
    headers: commandHeaders(actor, idempotencyKey),
    headersSchema: MobileCommandHeadersSchema,
    method: "POST",
    responseSchema: TripResponseSchema,
    url: "/v1/trips",
  });
}

async function createOutcome(
  actor: RouteActor,
  tripId: string,
  idempotencyKey: string,
) {
  assertContract(TripIdSchema, tripId, "create outcome trip id");
  return contractJson({
    app: actor.app,
    body: { tripId },
    bodySchema: CreateTripOutcomeBodySchema,
    expectedStatus: 200,
    headers: commandHeaders(actor, idempotencyKey),
    headersSchema: MobileCommandHeadersSchema,
    method: "POST",
    responseSchema: CreateTripOutcomeResponseSchema,
    url: "/v1/trips/create-outcome",
  });
}

async function requestJoin(
  actor: RouteActor,
  body: CreateJoinRequestBody,
  idempotencyKey: string,
): Promise<MembershipResponse> {
  return contractJson({
    app: actor.app,
    body,
    bodySchema: CreateJoinRequestBodySchema,
    expectedStatus: 201,
    headers: commandHeaders(actor, idempotencyKey),
    headersSchema: MobileCommandHeadersSchema,
    method: "POST",
    responseSchema: MembershipResponseSchema,
    url: "/v1/trips/join-requests",
  });
}

async function approveJoin(
  actor: RouteActor,
  tripId: string,
  membershipId: string,
  body: ApproveJoinRequestBody,
  idempotencyKey: string,
): Promise<MembershipResponse> {
  return contractJson({
    app: actor.app,
    body,
    bodySchema: ApproveJoinRequestBodySchema,
    expectedStatus: 200,
    headers: commandHeaders(actor, idempotencyKey),
    headersSchema: MobileCommandHeadersSchema,
    method: "PUT",
    responseSchema: MembershipResponseSchema,
    url: `/v1/trips/${tripId}/join-requests/${membershipId}/approval`,
  });
}

async function rejectJoin(
  actor: RouteActor,
  tripId: string,
  membershipId: string,
  idempotencyKey: string,
): Promise<void> {
  return contractEmpty({
    app: actor.app,
    expectedStatus: 204,
    headers: commandHeaders(actor, idempotencyKey),
    headersSchema: MobileCommandHeadersSchema,
    method: "DELETE",
    url: `/v1/trips/${tripId}/join-requests/${membershipId}`,
  });
}

async function setReadiness(
  actor: RouteActor,
  tripId: string,
  body: SetTripReadinessBody,
  idempotencyKey: string,
): Promise<TripResponse> {
  return contractJson({
    app: actor.app,
    body,
    bodySchema: SetTripReadinessBodySchema,
    expectedStatus: 200,
    headers: commandHeaders(actor, idempotencyKey),
    headersSchema: MobileCommandHeadersSchema,
    method: "PUT",
    responseSchema: TripResponseSchema,
    url: `/v1/trips/${tripId}/readiness`,
  });
}

async function startTrip(
  actor: RouteActor,
  tripId: string,
  body: StartTripBody,
  idempotencyKey: string,
): Promise<TripResponse> {
  return contractJson({
    app: actor.app,
    body,
    bodySchema: StartTripBodySchema,
    expectedStatus: 200,
    headers: commandHeaders(actor, idempotencyKey),
    headersSchema: MobileCommandHeadersSchema,
    method: "POST",
    responseSchema: TripResponseSchema,
    url: `/v1/trips/${tripId}/start`,
  });
}

async function getTrip(
  actor: RouteActor,
  tripId: string,
): Promise<TripResponse> {
  return contractJson({
    app: actor.app,
    expectedStatus: 200,
    headers: queryHeaders(actor),
    headersSchema: MobileQueryHeadersSchema,
    method: "GET",
    responseSchema: TripResponseSchema,
    url: `/v1/trips/${tripId}`,
  });
}

async function tripProblem({
  actor,
  body,
  bodySchema,
  code,
  idempotencyKey,
  method,
  status,
  url,
}: {
  readonly actor: RouteActor;
  readonly body?: unknown;
  readonly bodySchema?: TSchema;
  readonly code: ProblemCode;
  readonly idempotencyKey?: string;
  readonly method: HttpMethod;
  readonly status: number;
  readonly url: string;
}): Promise<ProblemDetails> {
  const payload = await contractJson({
    app: actor.app,
    body,
    ...(bodySchema === undefined ? {} : { bodySchema }),
    expectedStatus: status,
    headers:
      idempotencyKey === undefined
        ? queryHeaders(actor)
        : commandHeaders(actor, idempotencyKey),
    headersSchema:
      idempotencyKey === undefined
        ? MobileQueryHeadersSchema
        : MobileCommandHeadersSchema,
    method,
    responseSchema: ProblemDetailsSchema,
    url,
  });
  expect(payload.code).toBe(code);
  expect(payload.detail).not.toContain("postgres");
  expect(payload.detail).not.toContain("HMAC");
  return payload;
}

async function startLocalClerkJwks(): Promise<LocalClerkJwks> {
  const key: ClerkJwtKey = await createClerkJwtKey("task10-local-jwks-key");
  let requests = 0;
  const server: HttpServer = createHttpServer((request, response) => {
    requests += 1;
    if (request.url !== "/.well-known/jwks.json") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "cache-control": "public, max-age=600",
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ keys: [key.publicJwk] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${address.port}`;
  const nowSeconds = Math.floor(FIXED_CLOCK.getTime() / 1_000);
  return {
    issuer,
    requests: () => requests,
    sign: (subject) =>
      signClerkJwt({
        claims: { azp: AUTHORIZED_PARTY, sub: subject },
        issuer,
        key,
        nowSeconds,
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

function failAfterCreateIdempotencyInsert(
  unitOfWork: TripUnitOfWork,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) =>
        operation({
          ...transaction,
          async insertIdempotency(record) {
            await transaction.insertIdempotency(record);
            throw new Error("controlled pre-commit response cut");
          },
        }),
      );
    },
  };
}

function failAfterCommittedRun(unitOfWork: TripUnitOfWork): TripUnitOfWork {
  return {
    ...unitOfWork,
    async run(operation) {
      await unitOfWork.run(operation);
      throw new Error("controlled post-commit response cut");
    },
  };
}

function holdAfterTripLock(
  unitOfWork: TripUnitOfWork,
  held: Deferred,
  release: Deferred,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) => {
        let heldOnce = false;
        const decorated: TripTransaction = {
          ...transaction,
          async lockTrip(tripId) {
            const trip = await transaction.lockTrip(tripId);
            if (!heldOnce) {
              heldOnce = true;
              held.resolve();
              await release.promise;
            }
            return trip;
          },
        };
        return operation(decorated);
      });
    },
  };
}

function signalBeforeTripLock(
  unitOfWork: TripUnitOfWork,
  attempted: Deferred,
): TripUnitOfWork {
  return {
    ...unitOfWork,
    run(operation) {
      return unitOfWork.run((transaction) =>
        operation({
          ...transaction,
          lockTrip(tripId) {
            attempted.resolve();
            return transaction.lockTrip(tripId);
          },
        }),
      );
    },
  };
}

async function bounded<Value>(
  promise: Promise<Value>,
  label: string,
): Promise<Value> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} exceeded five seconds`)),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function tripId(sequence: number): string {
  return `018f0d98-76fa-7d1a-b4b4-${sequence.toString(16).padStart(12, "0")}`;
}

function commandId(sequence: number): string {
  return `10000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function tripBody(
  id: string,
  ownerDeviceId: string,
  inviteCode: string,
  name: string,
): CreateTripBody {
  return {
    endsAt: new Date(Date.now() + 7 * ONE_DAY_MS).toISOString(),
    inviteCode,
    name,
    ownerDeviceId,
    ownerKeyEnvelope: {
      algorithmVersion: 1,
      keyEpoch: 1,
      wrappedKey: OWNER_ENVELOPE,
    },
    release: { mode: "IMMEDIATE" },
    tripId: id,
  };
}

function approvalBody(): ApproveJoinRequestBody {
  return {
    algorithmVersion: 1,
    keyEpoch: 1,
    wrappedKey: MEMBER_ENVELOPE,
  };
}

function registrationBody(
  installationId: string,
  e2eePublicKey: string,
): RegisterDeviceBody {
  const { pushToken: _pushToken, ...body } = validRegisterDeviceBody();
  return { ...body, e2eePublicKey, installationId };
}

async function countRows(
  database: Kysely<Database>,
  table: string,
): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*)::text as count from ${sql.table(table)}
  `.execute(database);
  return Number(result.rows[0]?.count ?? "0");
}

async function raceLedger(
  database: Kysely<Database>,
  tripId: string,
  idempotencyKeys: readonly string[],
) {
  const [idempotency, inbox, memberships, outbox] = await Promise.all([
    database
      .selectFrom("api_idempotency")
      .select([
        "idempotency_key",
        "response_body",
        "response_status",
        "route_key",
      ])
      .where("idempotency_key", "in", idempotencyKeys)
      .orderBy("idempotency_key")
      .execute(),
    database
      .selectFrom("inbox_events")
      .select([
        "aggregate_id",
        "event_type",
        "payload",
        "recipient_device_id",
        "sequence",
        "trip_id",
      ])
      .where("trip_id", "=", tripId)
      .orderBy("sequence")
      .execute(),
    database
      .selectFrom("trip_members")
      .select([
        "full_photo_library_access",
        "id",
        "key_epoch",
        "participating_device_id",
        "role",
        "state",
      ])
      .where("trip_id", "=", tripId)
      .orderBy("role", "desc")
      .execute(),
    database
      .selectFrom("outbox_events")
      .select(["aggregate_id", "dedupe_key", "event_type", "payload"])
      .where("aggregate_id", "=", tripId)
      .orderBy("dedupe_key")
      .execute(),
  ]);
  return { idempotency, inbox, memberships, outbox };
}

describe.sequential("two-account Trip room public-route journey", () => {
  let clerk: LocalClerkJwks;
  let connectionString: string;
  let context: PostgresTestContext;
  const activeRuntimes = new Set<RouteRuntime>();
  const directoryCalls: string[] = [];
  const kmsCalls = { fingerprint: 0, protect: 0 };

  async function startRuntime(
    options: RuntimeOptions = {},
  ): Promise<RouteRuntime> {
    let capturedApp: TestApp | undefined;
    const environment = loadEnvironment({
      BACKGROUND_CREDENTIAL_HMAC_KEY_V1: BACKGROUND_HMAC_KEY,
      CLERK_AUTHORIZED_PARTIES_JSON: JSON.stringify([AUTHORIZED_PARTY]),
      CLERK_ISSUER: clerk.issuer,
      CLERK_WEBHOOK_SECRET: "whsec_task10_local_only",
      DATABASE_URL: connectionString,
      HOST: "127.0.0.1",
      INVITE_CODE_HMAC_KEY: "task10-real-invite-code-hmac-key",
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
      PORT: "3000",
    });
    const factories: ApiRuntimeFactories = {
      ...productionApiFactories,
      buildApp(dependencies) {
        const constructed = buildApp(dependencies);
        capturedApp = constructed;
        return constructed;
      },
      clock: () => ({ now: () => new Date(FIXED_CLOCK.getTime()) }),
      directory: () => ({
        getUser(clerkSubject) {
          directoryCalls.push(clerkSubject);
          const displayNames: Readonly<Record<string, string>> = {
            user_task10_invitee: "Bina Invitee",
            user_task10_owner: "Asha Owner",
          };
          return Promise.resolve({
            clerkSubject,
            displayName: displayNames[clerkSubject] ?? "Task 10 member",
          });
        },
      }),
      environment: () => environment,
      pushTokenProtector: () => ({
        destroy() {},
        protector: {
          fingerprint(token) {
            kmsCalls.fingerprint += 1;
            return createHash("sha256").update(token).digest();
          },
          protect(token, deviceId, platform) {
            kmsCalls.protect += 1;
            return Promise.resolve({
              encryptedToken: Buffer.from(
                `test-only:${platform}:${deviceId}:${token}`,
              ),
              fingerprint: createHash("sha256").update(token).digest(),
            });
          },
        },
      }),
      tripUnitOfWork(database) {
        const real = productionApiFactories.tripUnitOfWork(database);
        return options.decorateTripUnitOfWork?.(real) ?? real;
      },
    };
    const runtime = await createApiRuntime(factories);
    if (capturedApp === undefined) {
      await runtime.close();
      throw new Error("Task 10 runtime did not construct Fastify");
    }
    let closed = false;
    const handle: RouteRuntime = {
      app: capturedApp,
      async close() {
        if (closed) return;
        closed = true;
        activeRuntimes.delete(handle);
        await runtime.close();
      },
    };
    activeRuntimes.add(handle);
    return handle;
  }

  async function registerTwoAccounts(runtime: RouteRuntime): Promise<{
    readonly invitee: RegisteredAccount;
    readonly owner: RegisteredAccount;
  }> {
    const [ownerToken, inviteeToken] = await Promise.all([
      clerk.sign("user_task10_owner"),
      clerk.sign("user_task10_invitee"),
    ]);
    const ownerAuthorization = `Bearer ${ownerToken}`;
    const inviteeAuthorization = `Bearer ${inviteeToken}`;
    const [ownerDevice, inviteeDevice] = await Promise.all([
      registerDevice(
        runtime.app,
        ownerAuthorization,
        registrationBody("install_task10_owner", OWNER_E2EE_KEY),
        commandId(1),
      ),
      registerDevice(
        runtime.app,
        inviteeAuthorization,
        registrationBody("install_task10_invitee", MEMBER_E2EE_KEY),
        commandId(2),
      ),
    ]);
    expect(ownerDevice.deviceId).not.toBe(inviteeDevice.deviceId);
    expect(ownerDevice.backgroundBearer).not.toBe(
      inviteeDevice.backgroundBearer,
    );
    return {
      invitee: {
        authorization: inviteeAuthorization,
        device: inviteeDevice,
        subject: "user_task10_invitee",
      },
      owner: {
        authorization: ownerAuthorization,
        device: ownerDevice,
        subject: "user_task10_owner",
      },
    };
  }

  async function closeAllRuntimes(): Promise<void> {
    await Promise.all([...activeRuntimes].map((runtime) => runtime.close()));
  }

  beforeAll(async () => {
    clerk = await startLocalClerkJwks();
    context = await startMigratedPostgres();
    const resolved =
      resolveExplicitExternalPostgresUrl() ??
      context.container?.getConnectionUri();
    if (resolved === undefined) {
      throw new Error("Task 10 disposable PostgreSQL URI unavailable");
    }
    connectionString = resolved;
  });

  beforeEach(async () => {
    directoryCalls.length = 0;
    kmsCalls.fingerprint = 0;
    kmsCalls.protect = 0;
    await truncateIdentityTripTables(context.db);
  });

  afterEach(async () => {
    await closeAllRuntimes();
  });

  afterAll(async () => {
    await closeAllRuntimes();
    await Promise.all([clerk?.stop(), context?.stop()]);
  });

  it("recovers typed terminal and committed create outcomes after app recreation", async () => {
    // Steps 1 and 4: real API2 bootstrap plus controlled pre/post-commit cuts.
    const failedRuntime = await startRuntime({
      decorateTripUnitOfWork: failAfterCreateIdempotencyInsert,
    });
    const accounts = await registerTwoAccounts(failedRuntime);
    const failedOwner = actorOn(failedRuntime, accounts.owner);
    const terminalTrip = tripBody(
      tripId(1),
      accounts.owner.device.deviceId.toUpperCase(),
      "ABCD2345",
      "Terminal cut",
    );
    const terminalKey = commandId(10);
    await tripProblem({
      actor: failedOwner,
      body: terminalTrip,
      bodySchema: CreateTripBodySchema,
      code: "INTERNAL_ERROR",
      idempotencyKey: terminalKey,
      method: "POST",
      status: 500,
      url: "/v1/trips",
    });
    await failedRuntime.close();

    const recoveredRuntime = await startRuntime();
    const recoveredOwner = actorOn(recoveredRuntime, accounts.owner);
    await expect(
      createOutcome(recoveredOwner, terminalTrip.tripId, terminalKey),
    ).resolves.toEqual({ outcome: "TERMINAL_NOT_COMMITTED" });
    await tripProblem({
      actor: recoveredOwner,
      body: terminalTrip,
      bodySchema: CreateTripBodySchema,
      code: "CONFLICT",
      idempotencyKey: terminalKey,
      method: "POST",
      status: 409,
      url: "/v1/trips",
    });
    expect(await countRows(context.db, "trips")).toBe(0);
    await recoveredRuntime.close();

    const committedRuntime = await startRuntime({
      decorateTripUnitOfWork: failAfterCommittedRun,
    });
    const committedOwner = actorOn(committedRuntime, accounts.owner);
    const committedTrip = tripBody(
      tripId(2),
      accounts.owner.device.deviceId,
      "EFGH6789",
      "Committed cut",
    );
    const committedKey = commandId(11);
    // The real transaction commits, but the route loses the result before a
    // usable success response can reach the caller.
    await tripProblem({
      actor: committedOwner,
      body: committedTrip,
      bodySchema: CreateTripBodySchema,
      code: "INTERNAL_ERROR",
      idempotencyKey: committedKey,
      method: "POST",
      status: 500,
      url: "/v1/trips",
    });
    await committedRuntime.close();

    const restartedRuntime = await startRuntime();
    const restartedOwner = actorOn(restartedRuntime, accounts.owner);
    const outcome = await createOutcome(
      restartedOwner,
      committedTrip.tripId,
      committedKey,
    );
    expect(outcome.outcome).toBe("COMMITTED");
    if (outcome.outcome !== "COMMITTED") {
      throw new Error("Expected committed create recovery");
    }
    const replay = await createTrip(
      restartedOwner,
      committedTrip,
      committedKey,
    );
    expect(replay).toEqual(outcome.trip);
    expect(await countRows(context.db, "trips")).toBe(1);
    expect(kmsCalls).toEqual({ fingerprint: 0, protect: 0 });
    expect(directoryCalls.sort()).toEqual([
      accounts.invitee.subject,
      accounts.owner.subject,
    ]);
  });

  it("completes create, join, approve, readiness, Start, and frozen replays over public routes", async () => {
    // Steps 1-3: final API2 bootstrap, create, exact replay, and outcome.
    let runtime = await startRuntime();
    const accounts = await registerTwoAccounts(runtime);
    let owner = actorOn(runtime, accounts.owner);
    let invitee = actorOn(runtime, accounts.invitee);
    const id = tripId(10);
    const body = tripBody(
      id,
      accounts.owner.device.deviceId.toUpperCase(),
      "JKMN2345",
      "Two account room",
    );
    const createKey = commandId(100);
    const created = await createTrip(owner, body, createKey);
    expect(created).toMatchObject({
      id,
      ownerDeviceId: accounts.owner.device.deviceId,
      status: "LOBBY",
      tripKeyEnvelope: {
        algorithmVersion: 1,
        keyEpoch: 1,
        wrappedKey: OWNER_ENVELOPE,
      },
      version: 1,
    });
    expect(created.members).toHaveLength(1);
    expect(await createTrip(owner, body, createKey)).toEqual(created);
    await expect(createOutcome(owner, id, createKey)).resolves.toEqual({
      outcome: "COMMITTED",
      trip: created,
    });

    // Step 5: the join commits, its response is dropped, and an exact replay
    // after a complete runtime recreation resolves one membership identifier.
    const joinBody: CreateJoinRequestBody = {
      deviceId: accounts.invitee.device.deviceId.toUpperCase(),
      inviteCode: body.inviteCode,
    };
    const joinKey = commandId(101);
    await requestJoin(invitee, joinBody, joinKey);
    await runtime.close();
    runtime = await startRuntime();
    owner = actorOn(runtime, accounts.owner);
    invitee = actorOn(runtime, accounts.invitee);
    const pending = await requestJoin(invitee, joinBody, joinKey);
    expect(pending).toMatchObject({
      deviceId: accounts.invitee.device.deviceId,
      status: "PENDING_KEY",
      tripId: id,
      tripKeyEnvelope: null,
    });
    const inviteeMembershipRows = await context.db
      .selectFrom("trip_members")
      .select("id")
      .where("trip_id", "=", id)
      .where("participating_device_id", "=", accounts.invitee.device.deviceId)
      .execute();
    expect(inviteeMembershipRows).toEqual([{ id: pending.membershipId }]);

    // Step 6: only the owner can poll the pending nominated X25519 key.
    const ownerPending = await getTrip(owner, id);
    expect(ownerPending.version).toBe(2);
    const pendingMember = ownerPending.members.find(
      (member) => member.membershipId === pending.membershipId,
    );
    expect(pendingMember).toMatchObject({
      nominatedDevice: {
        deviceId: accounts.invitee.device.deviceId,
        e2eeKeyAlgorithm: "X25519",
        e2eeKeyVersion: 1,
        e2eePublicKey: MEMBER_E2EE_KEY,
      },
      status: "PENDING_KEY",
    });
    await tripProblem({
      actor: invitee,
      code: "NOT_FOUND",
      method: "GET",
      status: 404,
      url: `/v1/trips/${id}`,
    });

    // Step 7: owner approval installs exactly the caller's v1 envelope.
    const approveKey = commandId(102);
    const approved = await approveJoin(
      owner,
      id,
      pending.membershipId.toUpperCase(),
      approvalBody(),
      approveKey,
    );
    expect(approved).toMatchObject({
      membershipId: pending.membershipId,
      status: "ACTIVE",
      tripKeyEnvelope: {
        algorithmVersion: 1,
        keyEpoch: 1,
        wrappedKey: MEMBER_ENVELOPE,
      },
    });
    expect(await requestJoin(invitee, joinBody, joinKey)).toEqual(approved);
    const inviteeProjection = await getTrip(invitee, id);
    expect(inviteeProjection).toMatchObject({
      currentMembershipId: pending.membershipId,
      ownerDeviceId: accounts.owner.device.deviceId,
      tripKeyEnvelope: approved.tripKeyEnvelope,
      version: 3,
    });
    expect(inviteeProjection.members).toHaveLength(2);
    const inviteeSelf = inviteeProjection.members.find(
      (member) => member.membershipId === pending.membershipId,
    );
    expect(inviteeSelf).toMatchObject({
      membershipId: pending.membershipId,
      nominatedDevice: {
        deviceId: accounts.invitee.device.deviceId,
        e2eePublicKey: MEMBER_E2EE_KEY,
      },
    });
    expect(
      inviteeProjection.members
        .filter((member) => member.membershipId !== pending.membershipId)
        .every((member) => member.nominatedDevice === null),
    ).toBe(true);
    expect(JSON.stringify(inviteeProjection)).not.toContain(OWNER_E2EE_KEY);
    expect(JSON.stringify(inviteeProjection)).not.toContain(OWNER_ENVELOPE);

    // Step 9: each effective readiness transition increments once; exact
    // replays leave both the version and event ledger untouched.
    const ownerReadyKey = commandId(103);
    const inviteeReadyKey = commandId(104);
    const ownerReady = await setReadiness(
      owner,
      id,
      { fullPhotoLibraryAccess: true },
      ownerReadyKey,
    );
    expect(ownerReady.version).toBe(4);
    expect(
      await setReadiness(
        owner,
        id,
        { fullPhotoLibraryAccess: true },
        ownerReadyKey,
      ),
    ).toEqual(ownerReady);
    const inviteeReady = await setReadiness(
      invitee,
      id,
      { fullPhotoLibraryAccess: true },
      inviteeReadyKey,
    );
    expect(inviteeReady.version).toBe(5);
    expect(
      await setReadiness(
        invitee,
        id,
        { fullPhotoLibraryAccess: true },
        inviteeReadyKey,
      ),
    ).toEqual(inviteeReady);

    // Step 10: one real CAS freezes the two-member room at key epoch 1.
    const startKey = commandId(105);
    const started = await startTrip(
      owner,
      id,
      { expectedVersion: 5 },
      startKey,
    );
    expect(started).toMatchObject({
      keyEpoch: 1,
      status: "ACTIVE",
      version: 6,
    });
    expect(started.startsAt).not.toBeNull();
    expect(started.members).toHaveLength(2);
    const [ownerActive, inviteeActive] = await Promise.all([
      getTrip(owner, id),
      getTrip(invitee, id),
    ]);
    expect.soft(ownerActive).toMatchObject({
      currentMembershipId: created.currentMembershipId,
      keyEpoch: 1,
      status: "ACTIVE",
      version: 6,
    });
    expect.soft(inviteeActive).toMatchObject({
      currentMembershipId: pending.membershipId,
      keyEpoch: 1,
      status: "ACTIVE",
      version: 6,
    });
    expect(ownerActive.tripKeyEnvelope).toEqual({
      algorithmVersion: 1,
      keyEpoch: 1,
      wrappedKey: OWNER_ENVELOPE,
    });
    expect(inviteeActive.tripKeyEnvelope).toEqual({
      algorithmVersion: 1,
      keyEpoch: 1,
      wrappedKey: MEMBER_ENVELOPE,
    });
    expect(ownerActive.startsAt).toBe(started.startsAt);
    expect(inviteeActive.startsAt).toBe(started.startsAt);
    expect(ownerActive.members).toHaveLength(2);
    expect(
      ownerActive.members
        .map((member) => member.nominatedDevice?.deviceId)
        .sort(),
    ).toEqual(
      [accounts.owner.device.deviceId, accounts.invitee.device.deviceId].sort(),
    );
    expect(
      ownerActive.members.every(
        (member) =>
          member.status === "ACTIVE" &&
          member.nominatedDevice?.e2eeKeyVersion === 1,
      ),
    ).toBe(true);
    expect(JSON.stringify(ownerActive)).not.toContain(MEMBER_ENVELOPE);
    expect(inviteeActive.members).toHaveLength(2);
    expect(inviteeActive.tripKeyEnvelope).toEqual(approved.tripKeyEnvelope);
    expect(
      inviteeActive.members.find(
        (member) => member.membershipId === pending.membershipId,
      )?.nominatedDevice,
    ).toMatchObject({
      deviceId: accounts.invitee.device.deviceId,
      e2eePublicKey: MEMBER_E2EE_KEY,
    });
    expect(
      inviteeActive.members
        .filter((member) => member.membershipId !== pending.membershipId)
        .every((member) => member.nominatedDevice === null),
    ).toBe(true);
    expect(JSON.stringify(inviteeActive)).not.toContain(OWNER_E2EE_KEY);
    expect(JSON.stringify(inviteeActive)).not.toContain(OWNER_ENVELOPE);

    const stableBefore = {
      activeTrips: await context.db
        .selectFrom("user_active_trips")
        .selectAll()
        .where("trip_id", "=", id)
        .orderBy("user_id")
        .execute(),
      envelopes: await context.db
        .selectFrom("trip_key_envelopes")
        .selectAll()
        .where("trip_id", "=", id)
        .orderBy("recipient_device_id")
        .execute(),
      idempotency: await countRows(context.db, "api_idempotency"),
      inbox: await context.db
        .selectFrom("inbox_events")
        .selectAll()
        .where("trip_id", "=", id)
        .orderBy("sequence")
        .execute(),
      invites: await context.db
        .selectFrom("trip_invites")
        .selectAll()
        .where("trip_id", "=", id)
        .execute(),
      memberships: await context.db
        .selectFrom("trip_members")
        .selectAll()
        .where("trip_id", "=", id)
        .orderBy("id")
        .execute(),
      outbox: await context.db
        .selectFrom("outbox_events")
        .selectAll()
        .where("aggregate_id", "=", id)
        .orderBy("dedupe_key")
        .execute(),
      trip: await context.db
        .selectFrom("trips")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow(),
    };

    // Step 11: exact replays remain available, while every new post-Start
    // membership/readiness/Start mutation fails without changing durable state.
    expect(await requestJoin(invitee, joinBody, joinKey)).toEqual(approved);
    expect(
      await approveJoin(
        owner,
        id,
        pending.membershipId,
        approvalBody(),
        approveKey,
      ),
    ).toEqual(approved);
    expect(
      await setReadiness(
        owner,
        id,
        { fullPhotoLibraryAccess: true },
        ownerReadyKey,
      ),
    ).toMatchObject({ status: "ACTIVE", version: 6 });
    expect(
      await setReadiness(
        invitee,
        id,
        { fullPhotoLibraryAccess: true },
        inviteeReadyKey,
      ),
    ).toMatchObject({ status: "ACTIVE", version: 6 });
    await tripProblem({
      actor: invitee,
      body: joinBody,
      bodySchema: CreateJoinRequestBodySchema,
      code: "INVITE_INVALID",
      idempotencyKey: commandId(106),
      method: "POST",
      status: 404,
      url: "/v1/trips/join-requests",
    });
    await tripProblem({
      actor: owner,
      body: approvalBody(),
      bodySchema: ApproveJoinRequestBodySchema,
      code: "MEMBERSHIP_FROZEN",
      idempotencyKey: commandId(107),
      method: "PUT",
      status: 409,
      url: `/v1/trips/${id}/join-requests/${pending.membershipId}/approval`,
    });
    await tripProblem({
      actor: owner,
      code: "MEMBERSHIP_FROZEN",
      idempotencyKey: commandId(108),
      method: "DELETE",
      status: 409,
      url: `/v1/trips/${id}/join-requests/${pending.membershipId}`,
    });
    await tripProblem({
      actor: owner,
      body: { fullPhotoLibraryAccess: false },
      bodySchema: SetTripReadinessBodySchema,
      code: "MEMBERSHIP_FROZEN",
      idempotencyKey: commandId(109),
      method: "PUT",
      status: 409,
      url: `/v1/trips/${id}/readiness`,
    });
    await tripProblem({
      actor: owner,
      body: { expectedVersion: 6 },
      bodySchema: StartTripBodySchema,
      code: "TRIP_STATE_CONFLICT",
      idempotencyKey: commandId(110),
      method: "POST",
      status: 409,
      url: `/v1/trips/${id}/start`,
    });

    const stableAfter = {
      activeTrips: await context.db
        .selectFrom("user_active_trips")
        .selectAll()
        .where("trip_id", "=", id)
        .orderBy("user_id")
        .execute(),
      envelopes: await context.db
        .selectFrom("trip_key_envelopes")
        .selectAll()
        .where("trip_id", "=", id)
        .orderBy("recipient_device_id")
        .execute(),
      idempotency: await countRows(context.db, "api_idempotency"),
      inbox: await context.db
        .selectFrom("inbox_events")
        .selectAll()
        .where("trip_id", "=", id)
        .orderBy("sequence")
        .execute(),
      invites: await context.db
        .selectFrom("trip_invites")
        .selectAll()
        .where("trip_id", "=", id)
        .execute(),
      memberships: await context.db
        .selectFrom("trip_members")
        .selectAll()
        .where("trip_id", "=", id)
        .orderBy("id")
        .execute(),
      outbox: await context.db
        .selectFrom("outbox_events")
        .selectAll()
        .where("aggregate_id", "=", id)
        .orderBy("dedupe_key")
        .execute(),
      trip: await context.db
        .selectFrom("trips")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow(),
    };
    expect(stableAfter).toEqual(stableBefore);
    const outboxDedupeKeys = await context.db
      .selectFrom("outbox_events")
      .select("dedupe_key")
      .where("aggregate_id", "=", id)
      .orderBy("dedupe_key")
      .execute();
    expect(outboxDedupeKeys).toEqual(
      Array.from({ length: 5 }, (_unused, index) => ({
        dedupe_key: `trip.changed:${id}:v${index + 2}`,
      })),
    );

    // Step 14: Trip room orchestration never touches media/object/delivery
    // state and omitted push tokens keep the KMS boundary at zero calls.
    await expect(
      Promise.all(
        [
          "upload_sessions",
          "upload_objects",
          "assets",
          "asset_objects",
          "deliveries",
          "receipts",
        ].map((table) => countRows(context.db, table)),
      ),
    ).resolves.toEqual([0, 0, 0, 0, 0, 0]);
    expect(kmsCalls).toEqual({ fingerprint: 0, protect: 0 });
    expect(clerk.requests()).toBeGreaterThan(0);
  });

  it("keeps third-peer keys and envelopes out of a nonowner projection", async () => {
    // Step 8: the two-account route flow is real; only the extra peer is a
    // direct fixture so the projection can prove a three-member privacy set.
    const runtime = await startRuntime();
    const accounts = await registerTwoAccounts(runtime);
    const owner = actorOn(runtime, accounts.owner);
    const invitee = actorOn(runtime, accounts.invitee);
    const id = tripId(20);
    const body = tripBody(
      id,
      accounts.owner.device.deviceId,
      "NPQR2345",
      "Three peer privacy",
    );
    await createTrip(owner, body, commandId(200));
    const pending = await requestJoin(
      invitee,
      {
        deviceId: accounts.invitee.device.deviceId,
        inviteCode: body.inviteCode,
      },
      commandId(201),
    );
    const approved = await approveJoin(
      owner,
      id,
      pending.membershipId,
      approvalBody(),
      commandId(202),
    );

    const fixtures = createIdentityTripFixtures(context.db);
    const thirdUser = await fixtures.user({
      clerk_subject: "user_task10_projection_fixture",
      display_name: "Cora Peer",
    });
    const thirdDevice = await fixtures.device(thirdUser.id, {
      e2ee_public_key: Buffer.from(THIRD_E2EE_KEY, "base64"),
    });
    await fixtures.activeTrip(thirdUser.id, id);
    const thirdMembership = await fixtures.member(
      id,
      thirdUser.id,
      thirdDevice.id,
      { full_photo_library_access: true },
    );
    await fixtures.envelope(
      id,
      thirdDevice.id,
      accounts.owner.device.deviceId,
      {
        wrapped_key: Buffer.from(THIRD_ENVELOPE, "base64"),
      },
    );
    await context.db
      .updateTable("trips")
      .set({ member_count: 3 })
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

    const ownerProjection = await getTrip(owner, id);
    expect(ownerProjection.members).toHaveLength(3);
    expect(
      ownerProjection.members.map((member) => member.membershipId).sort(),
    ).toEqual(
      [
        ownerProjection.currentMembershipId,
        approved.membershipId,
        thirdMembership.id,
      ].sort(),
    );
    expect(
      ownerProjection.members.map(
        (member) => member.nominatedDevice?.e2eePublicKey,
      ),
    ).toEqual(
      expect.arrayContaining([OWNER_E2EE_KEY, MEMBER_E2EE_KEY, THIRD_E2EE_KEY]),
    );
    expect(ownerProjection.tripKeyEnvelope?.wrappedKey).toBe(OWNER_ENVELOPE);
    expect(JSON.stringify(ownerProjection)).not.toContain(MEMBER_ENVELOPE);
    expect(JSON.stringify(ownerProjection)).not.toContain(THIRD_ENVELOPE);

    const nonownerProjection = await getTrip(invitee, id);
    expect(nonownerProjection.ownerDeviceId).toBe(
      accounts.owner.device.deviceId,
    );
    expect(nonownerProjection.currentMembershipId).toBe(approved.membershipId);
    expect(nonownerProjection.tripKeyEnvelope).toEqual(
      approved.tripKeyEnvelope,
    );
    expect(nonownerProjection.members).toHaveLength(3);
    expect(
      nonownerProjection.members.map((member) => member.membershipId).sort(),
    ).toEqual(
      [
        ownerProjection.currentMembershipId,
        approved.membershipId,
        thirdMembership.id,
      ].sort(),
    );
    const callerMember = nonownerProjection.members.find(
      (member) => member.membershipId === approved.membershipId,
    );
    expect(callerMember).toMatchObject({
      nominatedDevice: {
        deviceId: accounts.invitee.device.deviceId,
        e2eeKeyAlgorithm: "X25519",
        e2eeKeyVersion: 1,
        e2eePublicKey: MEMBER_E2EE_KEY,
      },
    });
    expect(
      nonownerProjection.members
        .filter((member) => member.membershipId !== approved.membershipId)
        .every((member) => member.nominatedDevice === null),
    ).toBe(true);
    const serializedNonowner = JSON.stringify(nonownerProjection);
    expect(serializedNonowner).not.toContain(OWNER_E2EE_KEY);
    expect(serializedNonowner).not.toContain(THIRD_E2EE_KEY);
    expect(serializedNonowner).not.toContain(OWNER_ENVELOPE);
    expect(serializedNonowner).not.toContain(THIRD_ENVELOPE);
    expect(kmsCalls).toEqual({ fingerprint: 0, protect: 0 });
  });

  it("releases the rejected candidate slot and preserves the rejected join replay", async () => {
    // Step 12: a fresh two-account room proves rejection durability and slot
    // release without bypassing the public command routes.
    const runtime = await startRuntime();
    const accounts = await registerTwoAccounts(runtime);
    const owner = actorOn(runtime, accounts.owner);
    const invitee = actorOn(runtime, accounts.invitee);
    const id = tripId(30);
    const body = tripBody(
      id,
      accounts.owner.device.deviceId,
      "STVW2345",
      "Rejected room",
    );
    await createTrip(owner, body, commandId(300));
    const joinBody: CreateJoinRequestBody = {
      deviceId: accounts.invitee.device.deviceId,
      inviteCode: body.inviteCode,
    };
    const joinKey = commandId(301);
    const pending = await requestJoin(invitee, joinBody, joinKey);
    const rejectKey = commandId(302);
    await rejectJoin(owner, id, pending.membershipId, rejectKey);
    await rejectJoin(owner, id, pending.membershipId, rejectKey);

    const rejectedReplay = await requestJoin(invitee, joinBody, joinKey);
    expect(rejectedReplay).toEqual({
      deviceId: accounts.invitee.device.deviceId,
      keyEpoch: 1,
      membershipId: pending.membershipId,
      status: "REJECTED",
      tripId: id,
      tripKeyEnvelope: null,
    });
    await tripProblem({
      actor: invitee,
      code: "NOT_FOUND",
      method: "GET",
      status: 404,
      url: `/v1/trips/${id}`,
    });
    const inviteeUser = await context.db
      .selectFrom("users")
      .select("id")
      .where("clerk_subject", "=", accounts.invitee.subject)
      .executeTakeFirstOrThrow();
    await expect(
      context.db
        .selectFrom("user_active_trips")
        .selectAll()
        .where("user_id", "=", inviteeUser.id)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    const durableTrip = await context.db
      .selectFrom("trips")
      .select(["member_count", "state", "version"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(durableTrip).toEqual({
      member_count: 1,
      state: "LOBBY",
      version: 3,
    });
    const durableMembership = await context.db
      .selectFrom("trip_members")
      .select(["id", "rejected_at", "state"])
      .where("id", "=", pending.membershipId)
      .executeTakeFirstOrThrow();
    expect(durableMembership).toMatchObject({
      id: pending.membershipId,
      state: "REJECTED",
    });
    expect(durableMembership.rejected_at).toBeInstanceOf(Date);
    const ownerProjection = await getTrip(owner, id);
    expect(ownerProjection.version).toBe(3);
    expect(ownerProjection.members).toHaveLength(1);
    expect(await countRows(context.db, "inbox_events")).toBe(2);
    expect(await countRows(context.db, "outbox_events")).toBe(2);
    expect(kmsCalls).toEqual({ fingerprint: 0, protect: 0 });
  });

  it("physically serializes join-first and Start-first public-route barriers", async () => {
    // Step 13: each race uses two independent production runtime graphs and
    // database pools; only the real Trip UoW callback is paused at lockTrip.
    async function prepareOwnerRoom(
      sequence: number,
      inviteCode: string,
    ): Promise<{
      readonly accounts: Awaited<ReturnType<typeof registerTwoAccounts>>;
      readonly body: CreateTripBody;
      readonly ownerMembershipId: string;
    }> {
      const setup = await startRuntime();
      const accounts = await registerTwoAccounts(setup);
      const owner = actorOn(setup, accounts.owner);
      const body = tripBody(
        tripId(sequence),
        accounts.owner.device.deviceId,
        inviteCode,
        `Barrier room ${sequence}`,
      );
      await createTrip(owner, body, commandId(sequence * 10));
      const ready = await setReadiness(
        owner,
        body.tripId,
        { fullPhotoLibraryAccess: true },
        commandId(sequence * 10 + 1),
      );
      expect(ready.version).toBe(2);
      await setup.close();
      return {
        accounts,
        body,
        ownerMembershipId: ready.currentMembershipId,
      };
    }

    const joinFirst = await prepareOwnerRoom(40, "WXYZ2345");
    const joinHeld = deferred();
    const joinRelease = deferred();
    const startAttempted = deferred();
    const joinRuntime = await startRuntime({
      decorateTripUnitOfWork: (unitOfWork) =>
        holdAfterTripLock(unitOfWork, joinHeld, joinRelease),
    });
    const startRuntimeInstance = await startRuntime({
      decorateTripUnitOfWork: (unitOfWork) =>
        signalBeforeTripLock(unitOfWork, startAttempted),
    });
    const joinActor = actorOn(joinRuntime, joinFirst.accounts.invitee);
    const startActor = actorOn(startRuntimeInstance, joinFirst.accounts.owner);
    const joinPromise = requestJoin(
      joinActor,
      {
        deviceId: joinFirst.accounts.invitee.device.deviceId,
        inviteCode: joinFirst.body.inviteCode,
      },
      commandId(402),
    );
    await bounded(joinHeld.promise, "join-first lock acquisition");
    const startProblemPromise = tripProblem({
      actor: startActor,
      body: { expectedVersion: 3 },
      bodySchema: StartTripBodySchema,
      code: "PENDING_JOIN_REQUESTS",
      idempotencyKey: commandId(403),
      method: "POST",
      status: 409,
      url: `/v1/trips/${joinFirst.body.tripId}/start`,
    });
    try {
      await bounded(startAttempted.promise, "join-first competing Start");
    } finally {
      joinRelease.resolve();
    }
    const [joined] = await bounded(
      Promise.all([joinPromise, startProblemPromise]),
      "join-first public requests",
    );
    expect(joined.status).toBe("PENDING_KEY");
    const joinFirstTrip = await context.db
      .selectFrom("trips")
      .select(["member_count", "state", "version"])
      .where("id", "=", joinFirst.body.tripId)
      .executeTakeFirstOrThrow();
    const joinFirstInvite = await context.db
      .selectFrom("trip_invites")
      .select(["revoked_at", "uses_count"])
      .where("trip_id", "=", joinFirst.body.tripId)
      .executeTakeFirstOrThrow();
    expect(joinFirstTrip).toEqual({
      member_count: 2,
      state: "LOBBY",
      version: 3,
    });
    expect(joinFirstInvite).toEqual({ revoked_at: null, uses_count: 1 });
    expect
      .soft(
        await raceLedger(context.db, joinFirst.body.tripId, [
          commandId(400),
          commandId(401),
          commandId(402),
          commandId(403),
        ]),
      )
      .toEqual({
        idempotency: [
          {
            idempotency_key: commandId(400),
            response_body: {
              actorDeviceId: joinFirst.accounts.owner.device.deviceId,
              kind: "CREATE_COMMITTED",
              tripId: joinFirst.body.tripId,
            },
            response_status: 201,
            route_key: "trips.create.v1",
          },
          {
            idempotency_key: commandId(401),
            response_body: {
              actorDeviceId: joinFirst.accounts.owner.device.deviceId,
              kind: "READINESS",
              tripId: joinFirst.body.tripId,
            },
            response_status: 200,
            route_key: "trips.readiness.v1",
          },
          {
            idempotency_key: commandId(402),
            response_body: {
              actorDeviceId: joinFirst.accounts.invitee.device.deviceId,
              kind: "JOIN",
              membershipId: joined.membershipId,
              tripId: joinFirst.body.tripId,
            },
            response_status: 201,
            route_key: "trips.join.v1",
          },
        ],
        inbox: [
          {
            aggregate_id: joinFirst.body.tripId,
            event_type: "TRIP_CHANGED",
            payload: { status: "LOBBY" },
            recipient_device_id: joinFirst.accounts.owner.device.deviceId,
            sequence: "1",
            trip_id: joinFirst.body.tripId,
          },
        ],
        memberships: [
          {
            full_photo_library_access: true,
            id: joinFirst.ownerMembershipId,
            key_epoch: 1,
            participating_device_id: joinFirst.accounts.owner.device.deviceId,
            role: "OWNER",
            state: "ACTIVE",
          },
          {
            full_photo_library_access: false,
            id: joined.membershipId,
            key_epoch: null,
            participating_device_id: joinFirst.accounts.invitee.device.deviceId,
            role: "MEMBER",
            state: "PENDING_KEY",
          },
        ],
        outbox: [
          {
            aggregate_id: joinFirst.body.tripId,
            dedupe_key: `trip.changed:${joinFirst.body.tripId}:v2`,
            event_type: "trip.changed",
            payload: {
              recipientSequences: [],
              status: "LOBBY",
              tripId: joinFirst.body.tripId,
              version: 2,
            },
          },
          {
            aggregate_id: joinFirst.body.tripId,
            dedupe_key: `trip.changed:${joinFirst.body.tripId}:v3`,
            event_type: "trip.changed",
            payload: {
              recipientSequences: ["1"],
              status: "LOBBY",
              tripId: joinFirst.body.tripId,
              version: 3,
            },
          },
        ],
      });

    await closeAllRuntimes();
    await truncateIdentityTripTables(context.db);

    const startFirst = await prepareOwnerRoom(41, "CDEF6789");
    const startHeld = deferred();
    const startRelease = deferred();
    const joinAttempted = deferred();
    const winningRuntime = await startRuntime({
      decorateTripUnitOfWork: (unitOfWork) =>
        holdAfterTripLock(unitOfWork, startHeld, startRelease),
    });
    const losingRuntime = await startRuntime({
      decorateTripUnitOfWork: (unitOfWork) =>
        signalBeforeTripLock(unitOfWork, joinAttempted),
    });
    const winningOwner = actorOn(winningRuntime, startFirst.accounts.owner);
    const losingJoiner = actorOn(losingRuntime, startFirst.accounts.invitee);
    const startPromise = startTrip(
      winningOwner,
      startFirst.body.tripId,
      { expectedVersion: 2 },
      commandId(412),
    );
    await bounded(startHeld.promise, "Start-first lock acquisition");
    const joinProblemPromise = tripProblem({
      actor: losingJoiner,
      body: {
        deviceId: startFirst.accounts.invitee.device.deviceId,
        inviteCode: startFirst.body.inviteCode,
      },
      bodySchema: CreateJoinRequestBodySchema,
      code: "INVITE_INVALID",
      idempotencyKey: commandId(413),
      method: "POST",
      status: 404,
      url: "/v1/trips/join-requests",
    });
    try {
      await bounded(joinAttempted.promise, "Start-first competing join");
    } finally {
      startRelease.resolve();
    }
    const [started] = await bounded(
      Promise.all([startPromise, joinProblemPromise]),
      "Start-first public requests",
    );
    expect(started).toMatchObject({ status: "ACTIVE", version: 3 });
    const startFirstTrip = await context.db
      .selectFrom("trips")
      .select(["member_count", "started_at", "state", "version"])
      .where("id", "=", startFirst.body.tripId)
      .executeTakeFirstOrThrow();
    const startFirstInvite = await context.db
      .selectFrom("trip_invites")
      .select(["revoked_at", "uses_count"])
      .where("trip_id", "=", startFirst.body.tripId)
      .executeTakeFirstOrThrow();
    expect(startFirstTrip).toMatchObject({
      member_count: 1,
      state: "ACTIVE",
      version: 3,
    });
    expect(startFirstTrip.started_at).toBeInstanceOf(Date);
    expect(startFirstInvite.uses_count).toBe(0);
    expect(startFirstInvite.revoked_at).toBeInstanceOf(Date);
    expect
      .soft(
        await raceLedger(context.db, startFirst.body.tripId, [
          commandId(410),
          commandId(411),
          commandId(412),
          commandId(413),
        ]),
      )
      .toEqual({
        idempotency: [
          {
            idempotency_key: commandId(410),
            response_body: {
              actorDeviceId: startFirst.accounts.owner.device.deviceId,
              kind: "CREATE_COMMITTED",
              tripId: startFirst.body.tripId,
            },
            response_status: 201,
            route_key: "trips.create.v1",
          },
          {
            idempotency_key: commandId(411),
            response_body: {
              actorDeviceId: startFirst.accounts.owner.device.deviceId,
              kind: "READINESS",
              tripId: startFirst.body.tripId,
            },
            response_status: 200,
            route_key: "trips.readiness.v1",
          },
          {
            idempotency_key: commandId(412),
            response_body: {
              actorDeviceId: startFirst.accounts.owner.device.deviceId,
              kind: "START",
              tripId: startFirst.body.tripId,
            },
            response_status: 200,
            route_key: "trips.start.v1",
          },
        ],
        inbox: [],
        memberships: [
          {
            full_photo_library_access: true,
            id: startFirst.ownerMembershipId,
            key_epoch: 1,
            participating_device_id: startFirst.accounts.owner.device.deviceId,
            role: "OWNER",
            state: "ACTIVE",
          },
        ],
        outbox: [
          {
            aggregate_id: startFirst.body.tripId,
            dedupe_key: `trip.changed:${startFirst.body.tripId}:v2`,
            event_type: "trip.changed",
            payload: {
              recipientSequences: [],
              status: "LOBBY",
              tripId: startFirst.body.tripId,
              version: 2,
            },
          },
          {
            aggregate_id: startFirst.body.tripId,
            dedupe_key: `trip.changed:${startFirst.body.tripId}:v3`,
            event_type: "trip.changed",
            payload: {
              recipientSequences: [],
              status: "ACTIVE",
              tripId: startFirst.body.tripId,
              version: 3,
            },
          },
        ],
      });
    expect(kmsCalls).toEqual({ fingerprint: 0, protect: 0 });
  });
});
