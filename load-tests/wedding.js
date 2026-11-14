// PRIVATE OUTPUT-ONLY SINGLE-SOURCE DERIVATIVE. NO LIVE EXECUTION AUTHORIZED.
// Parent02ea3ed571421e9bcc0c538191e19ea24545db9d2b693b0c727cf75f352c434d remains unchanged.
// Derived from public diagnostic source9d66e235; public source remains untouched.
// Artifact-only candidate. Root must review destination, identity setup and caps before execution.
// Opaque synthetic bytes + harness receipts; never evidence of native Photos saves or valid media.
import http from "k6/http";
import crypto from "k6/crypto";
import encoding from "k6/encoding";
import exec from "k6/execution";
import { sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const ORIGIN = "https://crewroll-api-production.uankitu.workers.dev";
const WORKFLOW_STAGE = __ENV.CREWROLL_STAGE;
function readWorkflowCase(allowed) {
  const invalid = () => { throw new Error("WORKLOAD_WORKFLOW_CONFIGURATION_INVALID"); };
  const raw = __ENV.CREWROLL_SYNTHETIC_LOAD_AUTH;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 24576) return invalid();
  let configured;
  try { configured = JSON.parse(raw); } catch { return invalid(); }
  const workload = configured && configured.workload;
  if (WORKFLOW_STAGE !== "burst" || !configured ||
      configured.stage !== WORKFLOW_STAGE ||
      configured.purpose !== "crewroll-synthetic-load-only" ||
      configured.origin !== ORIGIN ||
      !/^[a-f0-9]{40}$/.test(configured.deploymentSha || "") ||
      configured.deploymentSha !== __ENV.CREWROLL_AUDITED_SHA ||
      !/^[a-f0-9]{32}$/.test(configured.runId || "") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(configured.tripId || "") ||
      !workload || !allowed.includes(workload.case)) return invalid();
  return workload.case;
}
const STAGE = readWorkflowCase(["oneOwner100"]);
const CASES = {
  oneOwner100: { seed: 49, ownership: [100, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
};
if (!Object.prototype.hasOwnProperty.call(CASES, STAGE))
  throw new Error("STAGE_REQUIRES_ONE_OWNER_CASE");
const MAX_MS = 900000;
const MAX_DRAIN_ROUNDS = 450;
const MIN_POLL_INTERVAL_MS = 2000;
const PREVIEW_BYTES = 8 * 1024;
function nextRandom(state) {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}
function buildPlan(config) {
  const { seed, ownership } = config;
  if (
    !Array.isArray(ownership) ||
    ownership.length !== 10 ||
    ownership.some((n) => !Number.isInteger(n) || n < 0 || n > 100)
  )
    throw new Error("CAPTURE_VECTOR_INVALID");
  const total = ownership.reduce((a, b) => a + b, 0);
  if (total !== 100 || ownership.filter((n) => n > 0).length !== 1)
    throw new Error("CAPTURE_VECTOR_INVALID");
  let random = nextRandom(seed);
  const photoCounts = Array(10).fill(0);
  const sourceBytes = Array(10).fill(0);
  const captures = [];
  const sizeCounts = [0, 0, 0];
  const slots = ownership.flatMap((count, owner) => Array(count).fill(owner));
  for (let ordinal = 0; ordinal < total; ordinal++) {
    random = nextRandom(random);
    const owner = slots[ordinal];
    random = nextRandom(random);
    const sizeIndex = random % 3;
    const originalBytes = [64 * 1024, 256 * 1024, 1024 * 1024][sizeIndex];
    const photo = photoCounts[owner]++;
    sourceBytes[owner] += originalBytes + PREVIEW_BYTES;
    captures.push({ ordinal, owner, photo, originalBytes });
    sizeCounts[sizeIndex]++;
  }
  const uploadedBytes = sourceBytes.reduce((a, b) => a + b, 0);
  const previewPages = Math.ceil(total / 20);
  const pendingPages = ownership.map((n) =>
    Math.max(1, Math.ceil((total - n) / 100)),
  );
  const visibilityActor = ownership.lastIndexOf(0);
  const nonEmptySources = ownership.filter((n) => n > 0).length;
  const receivers = ownership.filter((n) => n < total).length;
  const plannedReplays = 2 * nonEmptySources + receivers;
  const requestCaps = ownership.map((n, owner) => {
    const expected = total - n;
    return (
      5 * n +
      (n > 0 ? 2 : 0) +
      4 * expected +
      (expected > 0 ? 1 : 0) +
      2 +
      (expected > 0
        ? MAX_DRAIN_ROUNDS * (previewPages + pendingPages[owner])
        : 0) +
      (owner === visibilityActor ? MAX_DRAIN_ROUNDS : 0)
    );
  });
  return {
    seed,
    total,
    ownership,
    sourceBytes,
    captures,
    sizeCounts,
    uploadedBytes,
    downloadedBytes: 9 * uploadedBytes,
    previewPages,
    pendingPages,
    visibilityActor,
    nonEmptySources,
    receivers,
    plannedReplays,
    requestCaps,
    requestCeiling: 41 + requestCaps.reduce((a, b) => a + b, 0),
  };
}
const PLAN = buildPlan(CASES[STAGE]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPABILITY =
  /^https:\/\/crewroll-api-production\.uankitu\.workers\.dev\/v1\/media\/object\?grant=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/;

const failures = new Counter("crewroll_assertion_failures");
const requests = new Counter("crewroll_requests");
const REQUEST_ROUTES = [
  "GET readiness",
  "GET transfer-state",
  "GET pending",
  "GET previews",
  "POST reserve",
  "POST reserve replay",
  "POST publish preview",
  "POST commit",
  "POST commit replay",
  "POST download session",
  "POST harness receipt",
  "POST receipt replay",
  "PUT object PREVIEW",
  "PUT object ORIGINAL",
  "GET object PREVIEW",
  "GET object ORIGINAL",
];
const ROUTE_REQUESTS = Object.fromEntries(
  REQUEST_ROUTES.map((name) => [
    name,
    {
      metricName: `crewroll_route_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_requests`,
      counter: new Counter(
        `crewroll_route_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_requests`,
      ),
      transportMetricName: `crewroll_route_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_transport_requests`,
      transportCounter: new Counter(
        `crewroll_route_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_transport_requests`,
      ),
      unexpectedStatusMetricName: `crewroll_route_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_unexpected_status_requests`,
      unexpectedStatusCounter: new Counter(
        `crewroll_route_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_unexpected_status_requests`,
      ),
    },
  ]),
);
const STATUS_CODES = [
  200, 201, 400, 401, 403, 404, 409, 410, 412, 413, 429, 500, 502, 503, 504,
];
const STATUS_COUNTS = Object.fromEntries(
  [...STATUS_CODES.map(String), "other", "transport"].map((code) => [
    code,
    {
      metricName: `crewroll_status_${code}_requests`,
      counter: new Counter(`crewroll_status_${code}_requests`),
    },
  ]),
);

// Finite diagnostic vocabularies: no URL, exception text, body, bearer or grant is retained.
const FAILURE_CODES = [
  "ACTOR_CONFIGURATION_INVALID",
  "AUTH_OR_SCOPE_REJECTED",
  "BACKEND_NOT_READY",
  "BODY_HASH_MISMATCH",
  "BODY_LENGTH_MISMATCH",
  "COMMIT_INVALID",
  "COMMIT_REPLAY_CHANGED",
  "CONTROL_BODY_INVALID",
  "CONTROL_CACHE_POLICY",
  "CONTROL_JSON_INVALID",
  "CREDENTIAL_OR_GRANT_EXPIRED",
  "DELIVERY_DRAIN_INCOMPLETE",
  "DOWNLOAD_BYTE_CEILING",
  "DOWNLOAD_GRANT_INVALID",
  "DOWNLOAD_SESSION_SCOPE",
  "DUPLICATE_OR_SOURCE_PENDING",
  "DURATION_CEILING",
  "ETAG_MISSING",
  "FINAL_QUEUE_NOT_EMPTY",
  "FOREIGN_ASSET_OR_SOURCE",
  "FOREIGN_DELIVERY",
  "INVALID_TIMESTAMP",
  "MANIFEST_MISMATCH",
  "PENDING_CURSOR_CYCLE",
  "PENDING_CURSOR_STALLED",
  "PENDING_PAGE_CEILING",
  "PENDING_PAGINATION_INVALID",
  "PREVIEW_CURSOR_STALLED",
  "PREVIEW_ITEM_INVALID",
  "PREVIEW_PAGE_CEILING",
  "PREVIEW_PAGINATION_INVALID",
  "PUBLICATION_INVALID",
  "RECEIPT_INVALID",
  "RECEIPT_REPLAY_CHANGED",
  "REDIRECT_FORBIDDEN",
  "REQUEST_CEILING",
  "RESERVATION_INVALID",
  "RESERVATION_REPLAY_CHANGED",
  "RESERVATION_VARIANTS_INVALID",
  "SECRET_CONFIGURATION_INVALID",
  "SECRET_UNAVAILABLE",
  "SETUP_REQUIRED",
  "TERMINAL_OR_EXPIRED",
  "TRANSPORT_FAILURE",
  "TRIP_NOT_EMPTY",
  "TRIP_NOT_READY",
  "UNEXPECTED_HTTP_STATUS",
  "UNKNOWN_FAILURE_CODE",
  "UNKNOWN_ROUTE_METRIC",
  "UPLOAD_BYTE_CEILING",
  "UPLOAD_GRANT_INVALID",
  "URL_SCOPE",
  "VU_SCOPE",
];
const TRANSPORT_CODES = [
  0,
  1000,
  1010,
  1020,
  1050,
  1100,
  1101,
  1110,
  1111,
  1200,
  1201,
  1202,
  1210,
  1211,
  1212,
  1213,
  1220,
  1300,
  1301,
  1310,
  1311,
  1600,
  ...Array.from({ length: 15 }, (_, i) => 1610 + i),
  ...Array.from({ length: 15 }, (_, i) => 1630 + i),
  ...Array.from({ length: 15 }, (_, i) => 1650 + i),
  1701,
];
const TIMING_BUCKETS = [
  "lt_1s",
  "1_to_5s",
  "5_to_20s",
  "20_to_30s",
  "gte_30s",
  "unknown",
];
const TRANSPORT_PHASES = [
  "blocked",
  "connecting",
  "tls_handshaking",
  "sending",
  "waiting",
  "receiving",
];
function diagnosticCounters(prefix, values) {
  return Object.fromEntries(
    values.map((value) => [
      String(value),
      {
        metricName: `${prefix}_${String(value).toLowerCase()}`,
        counter: new Counter(`${prefix}_${String(value).toLowerCase()}`),
      },
    ]),
  );
}
const FAILURE_COUNTS = diagnosticCounters("crewroll_failure", FAILURE_CODES);
const TRANSPORT_CODE_COUNTS = diagnosticCounters(
  "crewroll_transport_code",
  TRANSPORT_CODES,
);
const TRANSPORT_ELAPSED_COUNTS = diagnosticCounters(
  "crewroll_transport_elapsed",
  TIMING_BUCKETS,
);
const TRANSPORT_PHASE_COUNTS = Object.fromEntries(
  TRANSPORT_PHASES.map((phase) => [
    phase,
    diagnosticCounters(`crewroll_transport_${phase}`, TIMING_BUCKETS),
  ]),
);
function timingBucket(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0)
    return "unknown";
  if (ms < 1000) return "lt_1s";
  if (ms < 5000) return "1_to_5s";
  if (ms < 20000) return "5_to_20s";
  if (ms < 30000) return "20_to_30s";
  return "gte_30s";
}
function transportFailure(name, started, response) {
  STATUS_COUNTS.transport.counter.add(1);
  ROUTE_REQUESTS[name].transportCounter.add(1);
  const code = response?.error_code;
  const safeCode =
    Number.isInteger(code) && TRANSPORT_CODE_COUNTS[String(code)] ? code : 0;
  TRANSPORT_CODE_COUNTS[String(safeCode)].counter.add(1);
  TRANSPORT_ELAPSED_COUNTS[timingBucket(Date.now() - started)].counter.add(1);
  for (const phase of TRANSPORT_PHASES)
    TRANSPORT_PHASE_COUNTS[phase][
      timingBucket(response?.timings?.[phase])
    ].counter.add(1);
  return stop("TRANSPORT_FAILURE");
}

const serverErrors = new Rate("crewroll_server_error_rate");
const sent = new Counter("crewroll_ciphertext_uploaded_bytes");
const received = new Counter("crewroll_ciphertext_downloaded_bytes");
const polls = new Counter("crewroll_poll_requests");
const replays = new Counter("crewroll_replays");
const commits = new Counter("crewroll_commits");
const receipts = new Counter("crewroll_harness_receipts");
const actorsDone = new Counter("crewroll_completed_actors");
const sourcePartitions = new Counter("crewroll_source_partitions");
const activeSources = new Counter("crewroll_nonempty_source_partitions");
const paginatedPending = new Counter("crewroll_paginated_pending_pages");
const SOURCE_COMMITS = Array.from(
  { length: 10 },
  (_, owner) => new Counter(`crewroll_source_actor_${owner}_commits`),
);
const RECIPIENT_RECEIPTS = Array.from(
  { length: 10 },
  (_, owner) => new Counter(`crewroll_recipient_actor_${owner}_receipts`),
);
const controlMs = new Trend("crewroll_control_full_body_ms", true);
const objectMs = new Trend("crewroll_object_full_body_ms", true);
const captureCommitMs = new Trend("crewroll_capture_to_commit_ms", true);
const discoveryMs = new Trend("crewroll_commit_to_discovery_ms", true);
const receiptMs = new Trend("crewroll_download_to_harness_receipt_ms", true);
const drainMs = new Trend("crewroll_actor_drain_ms", true);
const clockSkew = new Counter("crewroll_future_server_timestamp_samples");

export const options = {
  scenarios: {
    wedding: {
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 1,
      maxDuration: "15m",
      gracefulStop: "0s",
    },
  },
  setupTimeout: "2m",
  maxRedirects: 0,
  throw: true, // Parse/program errors still throw; request network diagnostics require silent runner logs.
  discardResponseBodies: true,
  systemTags: [
    "status",
    "method",
    "name",
    "group",
    "check",
    "scenario",
    "expected_response",
  ],
  summaryTrendStats: ["avg", "min", "med", "p(95)", "p(99)", "max"],
  thresholds: {
    crewroll_assertion_failures: [{ threshold: "count==0", abortOnFail: true }],
    crewroll_server_error_rate: [
      { threshold: "rate<0.01", abortOnFail: true, delayAbortEval: "10s" },
    ],
    crewroll_control_full_body_ms: [
      { threshold: "p(95)<2000", abortOnFail: true, delayAbortEval: "20s" },
    ],
    crewroll_completed_actors: ["count==10"],
    crewroll_source_partitions: ["count==10"],
    crewroll_nonempty_source_partitions: ["count==1"],
    crewroll_replays: [`count==${PLAN.plannedReplays}`],
    crewroll_commits: [`count==${PLAN.total}`],
    crewroll_harness_receipts: [`count==${9 * PLAN.total}`],
    crewroll_ciphertext_uploaded_bytes: [`count==${PLAN.uploadedBytes}`],
    crewroll_ciphertext_downloaded_bytes: [`count==${PLAN.downloadedBytes}`],
  },
};

let count = 0;
let sentBytes = 0;
let downloadReserved = 0;
let bundle;
let fixtures;
let cachedAsset;
let scope;
let deadline;

function stop(code) {
  const safeCode = Object.prototype.hasOwnProperty.call(FAILURE_COUNTS, code)
    ? code
    : "UNKNOWN_FAILURE_CODE";
  FAILURE_COUNTS[safeCode].counter.add(1);
  failures.add(1, { reason: safeCode });
  exec.test.abort(safeCode);
  throw new Error(safeCode);
}
function requireValue(condition, code) {
  if (!condition) stop(code);
}
function date(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  requireValue(Number.isFinite(parsed), "INVALID_TIMESTAMP");
  return parsed;
}
function liveUntil(value, slack = 30000) {
  requireValue(date(value) > Date.now() + slack, "CREDENTIAL_OR_GRANT_EXPIRED");
}
function header(response, wanted) {
  const key = Object.keys(response.headers).find(
    (name) => name.toLowerCase() === wanted,
  );
  return key ? response.headers[key] : undefined;
}
function id(label) {
  const hex = crypto
    .sha256(`${bundle.runId}:${STAGE}:${label}`, "hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
function parse(response) {
  requireValue(
    typeof response.body === "string" && response.body.length <= 262144,
    "CONTROL_BODY_INVALID",
  );
  try {
    return response.json();
  } catch {
    return stop("CONTROL_JSON_INVALID");
  }
}
function request(method, path, body, actor, name, expected, object = false) {
  requireValue(
    ++count <=
      (exec.vu.idInTest === 0 ? 41 : PLAN.requestCaps[exec.vu.idInTest - 1]),
    "REQUEST_CEILING",
  );
  if (deadline) requireValue(Date.now() < deadline, "DURATION_CEILING");
  const url = object ? path : ORIGIN + path;
  requireValue(
    object ? CAPABILITY.test(url) : path.startsWith("/"),
    "URL_SCOPE",
  );
  const params = {
    headers: actor
      ? {
          Authorization: `Bearer ${actor.backgroundBearer}`,
          "X-CrewRoll-Device-Id": actor.deviceId,
        }
      : {},
    tags: { name, kind: object ? "object" : "control", stage: STAGE },
    responseType: object ? (method === "GET" ? "binary" : "none") : "text",
    redirects: 0,
    timeout: object ? "30s" : "20s",
    // Pinned k6 2.4.0 returns numeric error_code instead of discarding the Response.
    // This can log internally: the reviewed workflow MUST keep --log-output=none and DEVNULL.
    throw: false,
  };
  let payload = body;
  if (actor && method === "POST") {
    params.headers["Content-Type"] = "application/json";
    params.headers["Idempotency-Key"] = body.commandId;
    payload = JSON.stringify(body.value);
  }
  if (object && method === "PUT") {
    params.headers = body.headers;
    payload = body.bytes;
  }
  requireValue(ROUTE_REQUESTS[name] !== undefined, "UNKNOWN_ROUTE_METRIC");
  ROUTE_REQUESTS[name].counter.add(1);
  requests.add(1, { name, kind: object ? "object" : "control" });
  const started = Date.now();
  let response;
  try {
    response = http.request(method, url, payload, params);
  } catch {
    return transportFailure(name, started);
  } // Never inspect/stringify the exception or Response.error.
  // Body-stream failures can retain HTTP 200; status alone cannot distinguish them.
  if (
    response.status === 0 ||
    (typeof response.error_code === "number" &&
      response.error_code !== 0 &&
      !(response.error_code >= 1400 && response.error_code <= 1599))
  )
    return transportFailure(name, started, response);
  if (response.status !== expected)
    ROUTE_REQUESTS[name].unexpectedStatusCounter.add(1);
  (STATUS_COUNTS[String(response.status)] || STATUS_COUNTS.other).counter.add(
    1,
  );
  serverErrors.add(response.status >= 500, {
    kind: object ? "object" : "control",
  });
  (object ? objectMs : controlMs).add(Date.now() - started, { name });
  if (response.status === 401 || response.status === 403)
    stop("AUTH_OR_SCOPE_REJECTED");
  if (response.status === 409 || response.status === 410)
    stop("TERMINAL_OR_EXPIRED");
  requireValue(response.status === expected, "UNEXPECTED_HTTP_STATUS");
  requireValue(!header(response, "location"), "REDIRECT_FORBIDDEN");
  if (!object)
    requireValue(
      header(response, "cache-control") === "no-store",
      "CONTROL_CACHE_POLICY",
    );
  return response;
}
function get(path, actor, name) {
  return parse(request("GET", path, null, actor, name, 200));
}
function post(path, value, actor, label, name, expected = 200) {
  return parse(
    request(
      "POST",
      path,
      { value, commandId: id(label) },
      actor,
      name,
      expected,
    ),
  );
}
async function configuration() {
  if (bundle) return bundle;
  let raw;
  try {
    raw = __ENV.CREWROLL_SYNTHETIC_LOAD_AUTH;
    requireValue(
      typeof raw === "string" && raw.length > 0 && raw.length <= 24576,
      "SECRET_UNAVAILABLE",
    );
  } catch {
    return stop("SECRET_UNAVAILABLE");
  }
  try {
    bundle = JSON.parse(raw);
  } catch {
    return stop("SECRET_CONFIGURATION_INVALID");
  }
  requireValue(
    bundle &&
      bundle.origin === ORIGIN &&
      bundle.purpose === "crewroll-synthetic-load-only" &&
      /^[a-f0-9]{40}$/.test(bundle.deploymentSha) &&
      bundle.deploymentSha === __ENV.CREWROLL_AUDITED_SHA &&
      UUID.test(bundle.tripId) &&
      /^[a-f0-9]{32}$/.test(bundle.runId) &&
      bundle.stage === WORKFLOW_STAGE &&
      Array.isArray(bundle.actors) &&
      bundle.actors.length === 10,
    "SECRET_CONFIGURATION_INVALID",
  );
  const unique = new Set();
  for (const actor of bundle.actors) {
    requireValue(
      actor &&
        UUID.test(actor.deviceId) &&
        typeof actor.backgroundBearer === "string" &&
        actor.backgroundBearer.length >= 32 &&
        actor.backgroundBearer.length <= 4096 &&
        !/[\s\r\n]/.test(actor.backgroundBearer) &&
        !unique.has(actor.deviceId),
      "ACTOR_CONFIGURATION_INVALID",
    );
    unique.add(actor.deviceId);
  }
  liveUntil(bundle.expiresAt, MAX_MS + 180000);
  return bundle;
}
function transfer(actor, empty = false) {
  const state = get(
    `/v1/trips/${bundle.tripId}/transfer-state`,
    actor,
    "GET transfer-state",
  );
  requireValue(
    state.tripId === bundle.tripId &&
      state.status === "ACTIVE" &&
      state.participation === "JOINED" &&
      state.sharingPaused === false &&
      date(state.captureFrom) <= Date.now() &&
      Array.isArray(state.excludedCaptureWindows) &&
      state.excludedCaptureWindows.length === 0,
    "TRIP_NOT_READY",
  );
  liveUntil(state.captureUntil, empty ? MAX_MS + 60000 : 30000);
  liveUntil(state.deliveryDeadline, empty ? MAX_MS + 60000 : 30000);
  if (empty)
    requireValue(
      state.pendingUploads === 0 && state.pendingDownloads === 0,
      "TRIP_NOT_EMPTY",
    );
  return state;
}
function pending(actor, after) {
  polls.add(1, { route: "pending" });
  const page = get(
    `/v1/deliveries/pending?tripId=${bundle.tripId}${after ? `&after=${after}` : ""}`,
    actor,
    "GET pending",
  );
  requireValue(
    Array.isArray(page.items) &&
      page.items.length <= 100 &&
      typeof page.hasMore === "boolean" &&
      (page.nextCursor === null ||
        (typeof page.nextCursor === "string" && CURSOR.test(page.nextCursor))),
    "PENDING_PAGINATION_INVALID",
  );
  if (page.hasMore)
    requireValue(
      page.items.length > 0 && page.nextCursor && page.nextCursor !== after,
      "PENDING_CURSOR_STALLED",
    );
  if (after) paginatedPending.add(1);
  return page;
}
function previews(actor, after = "0") {
  polls.add(1, { route: "previews" });
  const page = get(
    `/v1/trips/${bundle.tripId}/previews?after=${after}`,
    actor,
    "GET previews",
  );
  requireValue(
    Array.isArray(page.items) &&
      page.items.length <= 20 &&
      typeof page.hasMore === "boolean" &&
      DECIMAL.test(page.nextCursor),
    "PREVIEW_PAGINATION_INVALID",
  );
  if (page.hasMore)
    requireValue(
      page.items.length > 0 && page.nextCursor !== after,
      "PREVIEW_CURSOR_STALLED",
    );
  return page;
}
export async function setup() {
  await configuration();
  requireValue(
    get("/health/ready", null, "GET readiness").status === "ready",
    "BACKEND_NOT_READY",
  );
  for (const actor of bundle.actors) {
    transfer(actor, true);
    const deliveries = pending(actor);
    const feed = previews(actor);
    requireValue(
      deliveries.items.length === 0 &&
        !deliveries.hasMore &&
        feed.items.length === 0 &&
        !feed.hasMore,
      "TRIP_NOT_EMPTY",
    );
  }
  // No credential/setup object is serialized to VUs or artifacts.
  return { startedAt: Date.now() };
}
function bytes(length, label) {
  const array = new Uint8Array(length);
  let state =
    parseInt(
      crypto.sha256(`${bundle.runId}:${label}`, "hex").slice(0, 8),
      16,
    ) || 1;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    array[i] = state & 255;
  }
  return array.buffer; // deterministic synthetic noise, not an encryption primitive
}
function initFixtures() {
  scope = new Map();
  for (const capture of PLAN.captures) {
    const assetId = id(`asset:${capture.owner}:${capture.photo}`);
    scope.set(assetId, {
      ...capture,
      assetId,
      sourceDeviceId: bundle.actors[capture.owner].deviceId,
    });
  }
  fixtures = undefined;
  cachedAsset = undefined;
}
function validAsset(assetId, sourceDeviceId) {
  const capture = scope.get(assetId);
  requireValue(
    capture && capture.sourceDeviceId === sourceDeviceId,
    "FOREIGN_ASSET_OR_SOURCE",
  );
  return capture;
}
function fixture(assetId, variant) {
  const capture = scope.get(assetId);
  requireValue(
    capture && (variant === "PREVIEW" || variant === "ORIGINAL"),
    "FOREIGN_ASSET_OR_SOURCE",
  );
  if (cachedAsset !== assetId) {
    cachedAsset = assetId;
    fixtures = {
      manifest: encoding.b64encode(bytes(784, `${assetId}:manifest`), "std"),
    };
  }
  if (!fixtures[variant]) {
    const length =
      variant === "PREVIEW" ? PREVIEW_BYTES : capture.originalBytes;
    const buffer = bytes(length, `${assetId}:${variant}`);
    fixtures[variant] = {
      bytes: buffer,
      length,
      checksum: crypto.sha256(buffer, "base64"),
    };
  }
  return fixtures[variant];
}
function manifestFor(assetId) {
  fixture(assetId, "PREVIEW");
  return fixtures.manifest;
}
function download(grant, variant, assetId) {
  requireValue(grant.assetId === assetId, "DOWNLOAD_SESSION_SCOPE");
  const expectedFixture = fixture(assetId, variant);
  liveUntil(grant.expiresAt);
  requireValue(
    grant.encryptedManifest === manifestFor(assetId),
    "MANIFEST_MISMATCH",
  );
  const object =
    variant === "PREVIEW" ? grant.object : grant.objects && grant.objects[0];
  requireValue(
    object &&
      object.variant === variant &&
      object.ciphertextBytes === String(expectedFixture.length) &&
      object.checksumSha256 === expectedFixture.checksum &&
      CAPABILITY.test(object.url),
    "DOWNLOAD_GRANT_INVALID",
  );
  downloadReserved += expectedFixture.length;
  requireValue(
    downloadReserved <=
      PLAN.uploadedBytes - PLAN.sourceBytes[exec.vu.idInTest - 1],
    "DOWNLOAD_BYTE_CEILING",
  );
  const response = request(
    "GET",
    object.url,
    null,
    null,
    `GET object ${variant}`,
    200,
    true,
  );
  requireValue(
    response.body instanceof ArrayBuffer &&
      response.body.byteLength === expectedFixture.length,
    "BODY_LENGTH_MISMATCH",
  );
  requireValue(
    crypto.sha256(response.body, "base64") === expectedFixture.checksum,
    "BODY_HASH_MISMATCH",
  );
  received.add(response.body.byteLength, { variant });
}
function put(object, variant, assetId) {
  const expectedFixture = fixture(assetId, variant);
  const headers = object.requiredHeaders;
  requireValue(
    object.variant === variant &&
      !object.uploadedEtag &&
      headers &&
      Object.keys(headers).length === 4 &&
      headers["content-length"] === String(expectedFixture.length) &&
      headers["content-type"] === "application/octet-stream" &&
      headers["x-amz-checksum-sha256"] === expectedFixture.checksum &&
      headers["if-none-match"] === "*",
    "UPLOAD_GRANT_INVALID",
  );
  sentBytes += expectedFixture.length;
  requireValue(
    sentBytes <= PLAN.sourceBytes[exec.vu.idInTest - 1],
    "UPLOAD_BYTE_CEILING",
  );
  const response = request(
    "PUT",
    object.url,
    { headers, bytes: expectedFixture.bytes },
    null,
    `PUT object ${variant}`,
    200,
    true,
  );
  const etag = header(response, "etag");
  requireValue(
    typeof etag === "string" && etag.length > 0 && etag.length <= 256,
    "ETAG_MISSING",
  );
  sent.add(expectedFixture.length, { variant });
  return etag;
}
function upload(actor, owner, photo) {
  const started = Date.now();
  const assetId = id(`asset:${owner}:${photo}`);
  const label = `upload:${owner}:${photo}`;
  const body = {
    tripId: bundle.tripId,
    assetId,
    sourceAssetKey: `src_${encoding.b64encode(crypto.sha256(`${bundle.runId}:${label}`, "binary"), "rawurl")}`,
    capturedAt: new Date().toISOString(),
    formatVersion: 1,
    keyEpoch: 1,
    encryptedManifest: manifestFor(assetId),
    objects: ["PREVIEW", "ORIGINAL"].map((variant) => ({
      variant,
      ciphertextBytes: String(fixture(assetId, variant).length),
      checksumSha256: fixture(assetId, variant).checksum,
    })),
  };
  const reservation = post(
    "/v1/assets/upload-sessions",
    body,
    actor,
    label,
    "POST reserve",
    201,
  );
  requireValue(
    reservation.assetId === assetId &&
      UUID.test(reservation.uploadSessionId) &&
      Array.isArray(reservation.objects) &&
      reservation.objects.length === 2,
    "RESERVATION_INVALID",
  );
  liveUntil(reservation.expiresAt);
  const preview = reservation.objects.find(
    (object) => object.variant === "PREVIEW",
  );
  const original = reservation.objects.find(
    (object) => object.variant === "ORIGINAL",
  );
  requireValue(preview && original, "RESERVATION_VARIANTS_INVALID");
  const previewEtag = put(preview, "PREVIEW", assetId);
  const publication = post(
    `/v1/assets/${assetId}/preview`,
    { uploadSessionId: reservation.uploadSessionId, etag: previewEtag },
    actor,
    `publish:${owner}:${photo}`,
    "POST publish preview",
  );
  requireValue(
    publication.assetId === assetId &&
      Number.isFinite(date(publication.publishedAt)),
    "PUBLICATION_INVALID",
  );
  const originalEtag = put(original, "ORIGINAL", assetId);
  const commitBody = {
    uploadSessionId: reservation.uploadSessionId,
    objects: [
      { variant: "PREVIEW", etag: previewEtag },
      { variant: "ORIGINAL", etag: originalEtag },
    ],
  };
  const result = post(
    `/v1/assets/${assetId}/commit`,
    commitBody,
    actor,
    `commit:${owner}:${photo}`,
    "POST commit",
  );
  requireValue(
    result.assetId === assetId &&
      DECIMAL.test(result.sequence) &&
      date(result.committedAt) > 0,
    "COMMIT_INVALID",
  );
  captureCommitMs.add(Date.now() - started);
  commits.add(1);
  SOURCE_COMMITS[owner].add(1);
  // One explicit same-command reserve+commit replay per source partition.
  // Never retry failed mutations or object bytes.
  if (photo === 0) {
    const reservedAgain = post(
      "/v1/assets/upload-sessions",
      body,
      actor,
      label,
      "POST reserve replay",
      201,
    );
    requireValue(
      reservedAgain.uploadSessionId === reservation.uploadSessionId &&
        reservedAgain.assetId === assetId,
      "RESERVATION_REPLAY_CHANGED",
    );
    const committedAgain = post(
      `/v1/assets/${assetId}/commit`,
      commitBody,
      actor,
      `commit:${owner}:${photo}`,
      "POST commit replay",
    );
    requireValue(
      committedAgain.assetId === result.assetId &&
        committedAgain.committedAt === result.committedAt &&
        committedAgain.sequence === result.sequence,
      "COMMIT_REPLAY_CHANGED",
    );
    replays.add(2);
  }
}
function drainOnce(actor, owner, state) {
  const before = state.seenPreviews.size + state.saved.size;
  const previewCursors = new Set();
  for (let pageCount = 0; ; pageCount++) {
    requireValue(pageCount < PLAN.previewPages, "PREVIEW_PAGE_CEILING");
    const prior = state.previewCursor;
    const page = previews(actor, prior);
    let last = BigInt(prior);
    for (const item of page.items) {
      validAsset(item.assetId, item.sourceDeviceId);
      requireValue(
        DECIMAL.test(item.sequence) &&
          BigInt(item.sequence) > last &&
          item.download &&
          item.download.assetId === item.assetId,
        "PREVIEW_ITEM_INVALID",
      );
      last = BigInt(item.sequence);
      if (
        item.sourceDeviceId !== actor.deviceId &&
        !state.seenPreviews.has(item.assetId)
      ) {
        download(item.download, "PREVIEW", item.assetId);
        state.seenPreviews.add(item.assetId);
      }
    }
    requireValue(
      BigInt(page.nextCursor) === last,
      "PREVIEW_PAGINATION_INVALID",
    );
    state.previewCursor = page.nextCursor;
    if (!page.hasMore) break;
    requireValue(
      !previewCursors.has(page.nextCursor),
      "PREVIEW_CURSOR_STALLED",
    );
    previewCursors.add(page.nextCursor);
  }
  let pendingCursor;
  const pendingCursors = new Set();
  for (let pageCount = 0; ; pageCount++) {
    requireValue(pageCount < PLAN.pendingPages[owner], "PENDING_PAGE_CEILING");
    const page = pending(actor, pendingCursor);
    for (const item of page.items) {
      requireValue(
        item.tripId === bundle.tripId && UUID.test(item.deliveryId),
        "FOREIGN_DELIVERY",
      );
      validAsset(item.assetId, item.sourceDeviceId);
      requireValue(
        item.sourceDeviceId !== actor.deviceId &&
          !state.saved.has(item.assetId),
        "DUPLICATE_OR_SOURCE_PENDING",
      );
      // A commit can race the preceding preview query. Leave it READY until
      // the next ordinary poll verifies its preview; do not retry a mutation.
      if (!state.seenPreviews.has(item.assetId)) continue;
      const latency = Date.now() - date(item.committedAt);
      if (latency >= 0) discoveryMs.add(latency);
      else clockSkew.add(1);
      const grant = post(
        `/v1/deliveries/${item.deliveryId}/download-session`,
        { variants: ["ORIGINAL"] },
        actor,
        `download:${owner}:${item.deliveryId}`,
        "POST download session",
      );
      requireValue(
        grant.deliveryId === item.deliveryId &&
          grant.assetId === item.assetId &&
          Array.isArray(grant.objects) &&
          grant.objects.length === 1,
        "DOWNLOAD_SESSION_SCOPE",
      );
      const started = Date.now();
      download(grant, "ORIGINAL", item.assetId);
      const body = {
        assetId: item.assetId,
        savedAt: new Date().toISOString(),
        engineRevision: 1,
      };
      const label = `receipt:${owner}:${item.deliveryId}`;
      const receipt = post(
        `/v1/deliveries/${item.deliveryId}/saved-receipt`,
        body,
        actor,
        label,
        "POST harness receipt",
      );
      requireValue(
        receipt.deliveryId === item.deliveryId &&
          receipt.status === "SAVED_LOCALLY" &&
          date(receipt.acceptedAt) > 0,
        "RECEIPT_INVALID",
      );
      if (state.saved.size === 0) {
        const again = post(
          `/v1/deliveries/${item.deliveryId}/saved-receipt`,
          body,
          actor,
          label,
          "POST receipt replay",
        );
        requireValue(
          again.deliveryId === receipt.deliveryId &&
            again.status === receipt.status &&
            again.acceptedAt === receipt.acceptedAt,
          "RECEIPT_REPLAY_CHANGED",
        );
        replays.add(1);
      }
      state.saved.add(item.assetId);
      receipts.add(1);
      RECIPIENT_RECEIPTS[owner].add(1);
      receiptMs.add(Date.now() - started);
    }
    if (!page.hasMore) break;
    requireValue(!pendingCursors.has(page.nextCursor), "PENDING_CURSOR_CYCLE");
    pendingCursors.add(page.nextCursor);
    pendingCursor = page.nextCursor;
  }
  return state.seenPreviews.size + state.saved.size > before;
}
function paceIncompletePoll(startedAt) {
  const remaining = MIN_POLL_INTERVAL_MS - (Date.now() - startedAt);
  if (remaining > 0) sleep(remaining / 1000);
}
function observeBacklog(actor, owner) {
  const expected = PLAN.total - PLAN.ownership[owner];
  for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
    requireValue(Date.now() < deadline, "DURATION_CEILING");
    const startedAt = Date.now();
    const status = transfer(actor);
    requireValue(status.pendingDownloads <= expected, "FOREIGN_DELIVERY");
    if (status.pendingDownloads === expected) return;
    paceIncompletePoll(startedAt);
  }
  stop("DELIVERY_DRAIN_INCOMPLETE");
}
export default async function scenario(data) {
  await configuration();
  const owner = exec.vu.idInTest - 1;
  requireValue(
    Number.isInteger(owner) &&
      owner >= 0 &&
      owner < 10 &&
      exec.scenario.iterationInTest < 10,
    "VU_SCOPE",
  );
  requireValue(
    data && Number.isFinite(data.startedAt) && data.startedAt <= Date.now(),
    "SETUP_REQUIRED",
  );
  deadline = data.startedAt + MAX_MS;
  initFixtures();
  const actor = bundle.actors[owner];
  const state = {
    seenPreviews: new Set(),
    saved: new Set(),
    previewCursor: "0",
  };
  const expected = PLAN.total - PLAN.ownership[owner];
  for (let photo = 0; photo < PLAN.ownership[owner]; photo++)
    upload(actor, owner, photo);
  sourcePartitions.add(1);
  if (PLAN.ownership[owner] > 0) activeSources.add(1);
  // Receive-only actor9 accumulates exactly100 originals to verify the final
  // full pending page has hasMore:false. All other receivers drain while the
  // single producer continues. A quiet/empty early queue never means complete.
  if (owner === PLAN.visibilityActor) observeBacklog(actor, owner);
  for (
    let pass = 0;
    pass < MAX_DRAIN_ROUNDS &&
    (state.seenPreviews.size < expected || state.saved.size < expected);
    pass++
  ) {
    requireValue(Date.now() < deadline, "DURATION_CEILING");
    const startedAt = Date.now();
    drainOnce(actor, owner, state);
    if (state.seenPreviews.size < expected || state.saved.size < expected)
      paceIncompletePoll(startedAt);
  }
  requireValue(
    state.seenPreviews.size === expected && state.saved.size === expected,
    "DELIVERY_DRAIN_INCOMPLETE",
  );
  const final = transfer(actor);
  const head = pending(actor);
  requireValue(
    final.pendingUploads === 0 &&
      final.pendingDownloads === 0 &&
      head.items.length === 0 &&
      !head.hasMore,
    "FINAL_QUEUE_NOT_EMPTY",
  );
  drainMs.add(Date.now() - data.startedAt);
  actorsDone.add(1);
}

// Only allowlisted aggregate numbers are written. HTTP responses, URLs and headers never enter artifacts.
const SAFE_METRICS = [
  "crewroll_assertion_failures",
  "crewroll_requests",
  "crewroll_server_error_rate",
  "crewroll_ciphertext_uploaded_bytes",
  "crewroll_ciphertext_downloaded_bytes",
  "crewroll_poll_requests",
  "crewroll_replays",
  "crewroll_commits",
  "crewroll_harness_receipts",
  "crewroll_completed_actors",
  "crewroll_source_partitions",
  "crewroll_nonempty_source_partitions",
  "crewroll_paginated_pending_pages",
  ...Array.from(
    { length: 10 },
    (_, owner) => `crewroll_source_actor_${owner}_commits`,
  ),
  ...Array.from(
    { length: 10 },
    (_, owner) => `crewroll_recipient_actor_${owner}_receipts`,
  ),
  "crewroll_control_full_body_ms",
  "crewroll_object_full_body_ms",
  "crewroll_capture_to_commit_ms",
  "crewroll_commit_to_discovery_ms",
  "crewroll_download_to_harness_receipt_ms",
  "crewroll_actor_drain_ms",
  "crewroll_future_server_timestamp_samples",
];
const SAFE_VALUES = new Set([
  "count",
  "rate",
  "avg",
  "min",
  "max",
  "med",
  "p(95)",
  "p(99)",
  "passes",
  "fails",
]);
const CONTROL_ROUTES = [
  "GET readiness",
  "GET transfer-state",
  "GET pending",
  "GET previews",
  "POST reserve",
  "POST reserve replay",
  "POST publish preview",
  "POST commit",
  "POST commit replay",
  "POST download session",
  "POST harness receipt",
  "POST receipt replay",
];
for (let owner = 0; owner < 10; owner++) {
  options.thresholds[`crewroll_source_actor_${owner}_commits`] = [
    `count==${PLAN.ownership[owner]}`,
  ];
  options.thresholds[`crewroll_recipient_actor_${owner}_receipts`] = [
    `count==${PLAN.total - PLAN.ownership[owner]}`,
  ];
}
for (const name of REQUEST_ROUTES)
  options.thresholds[ROUTE_REQUESTS[name].metricName] = ["count>0"];
for (const name of CONTROL_ROUTES)
  options.thresholds[`crewroll_control_full_body_ms{name:${name}}`] = [
    "p(95)<2000",
  ];
export function handleSummary(data) {
  const numbers = (metric) => {
    const safe = {};
    for (const [key, value] of Object.entries(metric?.values || {})) {
      if (
        SAFE_VALUES.has(key) &&
        typeof value === "number" &&
        Number.isFinite(value)
      )
        safe[key] = value;
    }
    return safe;
  };
  const metrics = {};
  for (const name of SAFE_METRICS) metrics[name] = numbers(data.metrics[name]);
  const routes = {};
  for (const name of CONTROL_ROUTES)
    routes[name] = numbers(
      data.metrics[`crewroll_control_full_body_ms{name:${name}}`],
    );
  const expected = {
    crewroll_completed_actors: 10,
    crewroll_commits: PLAN.total,
    crewroll_source_partitions: 10,
    crewroll_nonempty_source_partitions: 1,
    crewroll_replays: PLAN.plannedReplays,
    ...Object.fromEntries(
      PLAN.ownership.map((n, owner) => [
        `crewroll_source_actor_${owner}_commits`,
        n,
      ]),
    ),
    ...Object.fromEntries(
      PLAN.ownership.map((n, owner) => [
        `crewroll_recipient_actor_${owner}_receipts`,
        PLAN.total - n,
      ]),
    ),
    crewroll_harness_receipts: 9 * PLAN.total,
    crewroll_ciphertext_uploaded_bytes: PLAN.uploadedBytes,
    crewroll_ciphertext_downloaded_bytes: PLAN.downloadedBytes,
  };
  const complete = Object.entries(expected).every(
    ([name, value]) => metrics[name].count === value,
  );
  // Missing threshold series never count as green. Each declared route executes
  // in every supported case, so its custom trend must have a finite p95 plus
  // its separate request counter; an empty-trend zero alone is not evidence.
  const thresholdPass =
    Object.keys(options.thresholds).every((name) => {
      const metric = data.metrics[name];
      const entries = Object.values(metric?.thresholds || {});
      return (
        entries.length > 0 &&
        entries.every((threshold) => threshold.ok === true)
      );
    }) &&
    CONTROL_ROUTES.every((name) => {
      const trend = data.metrics[`crewroll_control_full_body_ms{name:${name}}`];
      const route = data.metrics[ROUTE_REQUESTS[name].metricName];
      return (
        Number.isFinite(trend?.values?.["p(95)"]) &&
        trend.values["p(95)"] < 2000 &&
        route?.values?.count > 0
      );
    });
  const routeCounts = {};
  const routeUnexpectedStatusCounts = {};
  const routeTransportCounts = {};
  for (const name of REQUEST_ROUTES) {
    routeCounts[name] =
      numbers(data.metrics[ROUTE_REQUESTS[name].metricName]).count || 0;
    routeTransportCounts[name] =
      numbers(data.metrics[ROUTE_REQUESTS[name].transportMetricName]).count ||
      0;
    routeUnexpectedStatusCounts[name] =
      numbers(data.metrics[ROUTE_REQUESTS[name].unexpectedStatusMetricName])
        .count || 0;
  }
  const statusCounts = {};
  for (const code of Object.keys(STATUS_COUNTS))
    statusCounts[code] =
      numbers(data.metrics[STATUS_COUNTS[code].metricName]).count || 0;
  const diagnosticCounts = (registry) =>
    Object.fromEntries(
      Object.entries(registry).map(([key, item]) => [
        key,
        numbers(data.metrics[item.metricName]).count || 0,
      ]),
    );
  const result = {
    schemaVersion: 1,
    execution: "standalone-k6-on-github-standard-runner",
    stage: STAGE,
    workflowStage: WORKFLOW_STAGE,
    outerProcessMaximumSeconds: 1050,
    workflowJobMaximumSeconds: 1200,
    deploymentSha: /^[a-f0-9]{40}$/.test(__ENV.CREWROLL_AUDITED_SHA || "")
      ? __ENV.CREWROLL_AUDITED_SHA
      : null,
    passed:
      complete &&
      (Math.max(...PLAN.pendingPages) <= 1 ||
        metrics.crewroll_paginated_pending_pages.count >= 1) &&
      thresholdPass &&
      (metrics.crewroll_assertion_failures.count || 0) === 0,
    scriptSha256: /^[a-f0-9]{64}$/.test(__ENV.CREWROLL_SCRIPT_SHA256 || "")
      ? __ENV.CREWROLL_SCRIPT_SHA256
      : null,
    plan: {
      seed: PLAN.seed,
      captures: PLAN.total,
      ownership: PLAN.ownership,
      sizeCounts: PLAN.sizeCounts,
      uploadBytes: PLAN.uploadedBytes,
      downloadBytes: PLAN.downloadedBytes,
      requestCaps: PLAN.requestCaps,
      requestCeiling: PLAN.requestCeiling,
      previewPageCeiling: PLAN.previewPages,
      pendingPageCeilings: PLAN.pendingPages,
    },
    nativePhotoEvidence: false,
    indiaNetworkEvidence: false,
    metrics,
    controlRoutes: routes,
    routeRequestCounts: routeCounts,
    routeUnexpectedStatusCounts,
    routeTransportCounts,
    failureCodeCounts: diagnosticCounts(FAILURE_COUNTS),
    transportErrorCodeCounts: diagnosticCounts(TRANSPORT_CODE_COUNTS),
    transportElapsedBuckets: diagnosticCounts(TRANSPORT_ELAPSED_COUNTS),
    transportPhaseTimingBuckets: Object.fromEntries(
      TRANSPORT_PHASES.map((phase) => [
        phase,
        diagnosticCounts(TRANSPORT_PHASE_COUNTS[phase]),
      ]),
    ),
    statusRequestCounts: statusCounts,
  };
  return { "sanitized-summary.json": JSON.stringify(result, null, 2) + "\n" };
}
