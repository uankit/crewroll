// PRIVATE OUTPUT-ONLY RESILIENCE DERIVATIVE. NOT EXECUTED.
// Strict recovery parent91b267a93ab92698347e21781786cd7db7716b9a001910ae6f91a319e3d27362 remains FAILED; its source/artifacts are unchanged.
// Frozen public original4a47c51e1843aa484019be2853613ea32ca512d27857ff3dc9ab7bd5d627328f; prior recovery12af3671d1c28e82dc284ea5d8a3b668fc9e7f551858cabd31479ac4f85bead7.
// Diagnostic public base9d66e235085d6a634c9910749d4e574f3d55896605cfebde03608cbca62c0188; existing recovery setup/default/expected-metrics retained.
// Artifact-only candidate. Root must review destination, identity setup and caps before execution.
// Opaque synthetic bytes + harness receipts; never evidence of native Photos saves or valid media.
import http from "k6/http";
import crypto from "k6/crypto";
import encoding from "k6/encoding";
import exec from "k6/execution";
import { sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const ORIGIN = "https://crewroll-api-production.uankitu.workers.dev";
const STAGE = __ENV.CREWROLL_STAGE;
if (STAGE !== "smoke" && STAGE !== "burst")
  throw new Error("STAGE_REQUIRES_SMOKE_OR_BURST");
const PHOTOS = STAGE === "smoke" ? 1 : 10;
const ORIGINAL_BYTES = (STAGE === "smoke" ? 1 : 4) * 1024 * 1024;
const PREVIEW_BYTES = 128 * 1024;
const MAX_MS = 1200000; // 20-minute internal resilience ceiling; unchanged workflow outer cap is 1050 seconds.
const REQUEST_CAP = 900; // per VU, plus <=41 setup requests
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPABILITY =
  /^https:\/\/crewroll-api-production\.uankitu\.workers\.dev\/v1\/media\/object\?grant=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/;

// The unchanged existing workflow forwards only the scoped auth bundle. Derive
// recovery configuration locally; never require new workflow permissions/env.
function readWorkflowRecovery() {
  const invalid = () => { throw new Error("RECOVERY_WORKFLOW_CONFIGURATION_INVALID"); };
  const raw = __ENV.CREWROLL_SYNTHETIC_LOAD_AUTH;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 24576) return invalid();
  let configured;
  try { configured = JSON.parse(raw); } catch { return invalid(); }
  const recovery = configured && configured.recovery;
  if (!configured || configured.origin !== ORIGIN ||
      configured.purpose !== "crewroll-synthetic-load-only" ||
      configured.stage !== "burst" || STAGE !== "burst" ||
      !/^[a-f0-9]{40}$/.test(configured.deploymentSha || "") ||
      configured.deploymentSha !== __ENV.CREWROLL_AUDITED_SHA ||
      !UUID.test(configured.tripId || "") ||
      !/^[a-f0-9]{32}$/.test(configured.runId || "") ||
      !recovery || recovery.expectedPending !== 558 ||
      !/^[a-f0-9]{32}$/.test(recovery.runId || "") ||
      recovery.runId === configured.runId ||
      recovery.tripId !== configured.tripId) return invalid();
  const derived = { expectedPending: recovery.expectedPending,
    runId: recovery.runId, tripId: recovery.tripId };
  for (const [name, value] of [
    ["CREWROLL_RECOVERY_EXPECTED_PENDING", String(derived.expectedPending)],
    ["CREWROLL_RECOVERY_RUN_ID", derived.runId],
    ["CREWROLL_RECOVERY_TRIP_ID", derived.tripId],
  ]) if (__ENV[name] !== undefined && __ENV[name] !== value) return invalid();
  return Object.freeze(derived);
}
const RECOVERY = readWorkflowRecovery();


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
  "PENDING_PAGE_OR_CURSOR_CEILING",
  "RECOVERY_ACTOR_COUNT_INVALID",
  "RECOVERY_ATTESTATION_INVALID",
  "RECOVERY_ATTESTED_COUNT_CHANGED",
  "RECOVERY_BASELINE_CHANGED",
  "RECOVERY_DRAIN_INCOMPLETE",
  "RECOVERY_FINAL_PENDING_NOT_EMPTY",
  "RECOVERY_OPEN_UPLOADS",
  "RECOVERY_SETUP_REQUIRED",
  "OBJECT_RETRY_EXHAUSTED",
  "OBJECT_RETRY_SCOPE",
  "OBJECT_ATTEMPT_BYTE_CEILING",
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
function transportFailure(name, started, response, softObjectFailure = false) {
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
  if (softObjectFailure) return response || null;
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
const controlMs = new Trend("crewroll_control_full_body_ms", true);
const objectMs = new Trend("crewroll_object_full_body_ms", true);
const captureCommitMs = new Trend("crewroll_capture_to_commit_ms", true);
const discoveryMs = new Trend("crewroll_commit_to_discovery_ms", true);
const receiptMs = new Trend("crewroll_download_to_harness_receipt_ms", true);
const drainMs = new Trend("crewroll_actor_drain_ms", true);
const clockSkew = new Counter("crewroll_future_server_timestamp_samples");
const objectAttempts = new Counter("crewroll_resilience_object_attempts");
const objectRetries = new Counter("crewroll_resilience_retry_attempts");
const retryableFailures = new Counter("crewroll_resilience_retryable_failures");
const recoveredCopies = new Counter("crewroll_resilience_recovered_copies");
const attemptReservedBytes = new Counter("crewroll_resilience_attempt_reserved_bytes");
const attemptReturnedBytes = new Counter("crewroll_resilience_returned_body_bytes");
const partialReturnedBytes = new Counter("crewroll_resilience_partial_body_bytes");
const retrySleepSeconds = new Counter("crewroll_resilience_backoff_seconds");
const RETRY_REASONS = ["transport", "short_body", "http_401", "http_403", "http_429", "http_5xx"];
const RETRY_REASON_COUNTS = diagnosticCounters("crewroll_resilience_reason", RETRY_REASONS);

export const options = {
  scenarios: {
    wedding: {
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 1,
      maxDuration: "20m",
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
    // Recoverable object5xx remain visible; control failures still abort immediately.
    // This derivative measures eventual delivery under explicit retries, not strict availability.
    crewroll_control_full_body_ms: [
      { threshold: "p(95)<2000", abortOnFail: true, delayAbortEval: "20s" },
    ],
    crewroll_completed_actors: ["count==10"],
    crewroll_commits: ["count==0"],
    crewroll_harness_receipts: [`count==${Number(RECOVERY.expectedPending)}`],
    crewroll_ciphertext_uploaded_bytes: [
      "count==0",
    ],
    crewroll_ciphertext_downloaded_bytes: [
      `count==${Number(RECOVERY.expectedPending) * ORIGINAL_BYTES}`,
    ],
  },
};

let count = 0;
let sentBytes = 0;
let downloadReserved = 0;
let bundle;
let fixtures;
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
function request(method, path, body, actor, name, expected, object = false, softObjectFailure = false) {
  if (softObjectFailure)
    requireValue(object && method === "GET" && name === "GET object ORIGINAL" && actor === null && expected === 200, "OBJECT_RETRY_SCOPE");
  requireValue(
    ++count <= (exec.vu.idInTest === 0 ? 41 : REQUEST_CAP),
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
    return transportFailure(name, started, undefined, softObjectFailure);
  } // Never inspect/stringify the exception or Response.error.
  // Body-stream failures can retain HTTP 200; status alone cannot distinguish them.
  if (
    response.status === 0 ||
    (typeof response.error_code === "number" &&
      response.error_code !== 0 &&
      !(response.error_code >= 1400 && response.error_code <= 1599))
  )
    return transportFailure(name, started, response, softObjectFailure);
  if (response.status !== expected)
    ROUTE_REQUESTS[name].unexpectedStatusCounter.add(1);
  (STATUS_COUNTS[String(response.status)] || STATUS_COUNTS.other).counter.add(
    1,
  );
  serverErrors.add(response.status >= 500, {
    kind: object ? "object" : "control",
  });
  (object ? objectMs : controlMs).add(Date.now() - started, { name });
  requireValue(!header(response, "location"), "REDIRECT_FORBIDDEN");
  if (softObjectFailure && (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500 && response.status <= 599))
    return response;
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
      bundle.stage === STAGE &&
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
      ["ACTIVE", "ENDING"].includes(state.status) &&
      ["JOINED", "LEAVING"].includes(state.participation) &&
      state.sharingPaused === false &&
      date(state.captureFrom) <= Date.now() &&
      Array.isArray(state.excludedCaptureWindows) &&
      state.excludedCaptureWindows.length === 0,
    "TRIP_NOT_READY",
  );
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
  const expected = Number(RECOVERY.expectedPending);
  const recoveryRunId = RECOVERY.runId;
  requireValue(
    STAGE === "burst" && UUID.test(RECOVERY.tripId || "") &&
      bundle.tripId === RECOVERY.tripId &&
      /^[a-f0-9]{32}$/.test(recoveryRunId || "") &&
      Number.isSafeInteger(expected) && expected > 0 && expected <= 90 * PHOTOS,
    "RECOVERY_ATTESTATION_INVALID",
  );
  requireValue(get("/health/ready", null, "GET readiness").status === "ready", "BACKEND_NOT_READY");
  initFixtures();
  const pendingByActor = [];
  for (const actor of bundle.actors) {
    const state = transfer(actor);
    liveUntil(state.deliveryDeadline, MAX_MS + 60000);
    requireValue(state.pendingUploads === 0, "RECOVERY_OPEN_UPLOADS");
    const seenAssets = new Set();
    const seenDeliveries = new Set();
    const cursors = new Set();
    let cursor;
    for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
      const page = pending(actor, cursor);
      for (const item of page.items) {
        requireValue(item.tripId === bundle.tripId && UUID.test(item.deliveryId), "FOREIGN_DELIVERY");
        validAsset(item.assetId, item.sourceDeviceId);
        requireValue(item.sourceDeviceId !== actor.deviceId && !seenAssets.has(item.assetId) && !seenDeliveries.has(item.deliveryId), "DUPLICATE_OR_SOURCE_PENDING");
        seenAssets.add(item.assetId); seenDeliveries.add(item.deliveryId);
      }
      if (!page.hasMore) {
        requireValue(page.nextCursor === null, "PENDING_PAGINATION_INVALID");
        break;
      }
      requireValue(pageIndex < 1 && !cursors.has(page.nextCursor), "PENDING_PAGE_OR_CURSOR_CEILING");
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    requireValue(seenAssets.size <= 9 * PHOTOS && Number.isSafeInteger(state.pendingDownloads) && state.pendingDownloads === seenAssets.size, "RECOVERY_BASELINE_CHANGED");
    pendingByActor.push(seenAssets.size);
  }
  requireValue(pendingByActor.reduce((sum, value) => sum + value, 0) === expected, "RECOVERY_ATTESTED_COUNT_CHANGED");
  // Force explicit zero-valued mutation metrics; no upload/commit call is made.
  sent.add(0); commits.add(0); received.add(0); receipts.add(0); replays.add(0);
  for (const metric of [objectAttempts, objectRetries, retryableFailures, recoveredCopies, attemptReservedBytes, attemptReturnedBytes, partialReturnedBytes, retrySleepSeconds]) metric.add(0);
  for (const reason of RETRY_REASONS) RETRY_REASON_COUNTS[reason].counter.add(0);
  return { startedAt: Date.now(), pendingByActor, expected, recoveryRunId };
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
  fixtures = {};
  for (const [variant, length] of [
    ["PREVIEW", PREVIEW_BYTES],
    ["ORIGINAL", ORIGINAL_BYTES],
  ]) {
    const buffer = bytes(length, variant);
    fixtures[variant] = {
      bytes: buffer,
      length,
      checksum: crypto.sha256(buffer, "base64"),
    };
  }
  // Worst admitted v1 metadata length. Opaque bytes are not a valid encrypted manifest.
  fixtures.manifest = encoding.b64encode(bytes(784, "manifest"), "std");
  scope = new Map();
  for (let owner = 0; owner < 10; owner++) {
    for (let photo = 0; photo < PHOTOS; photo++)
      scope.set(id(`asset:${owner}:${photo}`), bundle.actors[owner].deviceId);
  }
}
function validAsset(assetId, sourceDeviceId) {
  requireValue(
    scope.has(assetId) && scope.get(assetId) === sourceDeviceId,
    "FOREIGN_ASSET_OR_SOURCE",
  );
}
function downloadWithRetry(actor, item, prefix) {
  const fixture = fixtures.ORIGINAL;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      const seconds = attempt === 2 ? 4 : 8;
      requireValue(Date.now() + seconds * 1000 < deadline, "DURATION_CEILING");
      retrySleepSeconds.add(seconds); sleep(seconds);
      objectRetries.add(1);
    }
    // A new normal command creates a fresh grant on EVERY attempt; controls never retry.
    const grant = post(`/v1/deliveries/${item.deliveryId}/download-session`, { variants: ["ORIGINAL"] }, actor, `${prefix}:download:${attempt}`, "POST download session");
    requireValue(grant.deliveryId === item.deliveryId && grant.assetId === item.assetId && Array.isArray(grant.objects) && grant.objects.length === 1, "DOWNLOAD_SESSION_SCOPE");
    liveUntil(grant.expiresAt);
    requireValue(grant.encryptedManifest === fixtures.manifest, "MANIFEST_MISMATCH");
    const object = grant.objects[0];
    requireValue(object && object.variant === "ORIGINAL" && object.ciphertextBytes === String(fixture.length) && object.checksumSha256 === fixture.checksum && CAPABILITY.test(object.url), "DOWNLOAD_GRANT_INVALID");
    downloadReserved += fixture.length;
    requireValue(downloadReserved <= 9 * PHOTOS * 3 * ORIGINAL_BYTES, "OBJECT_ATTEMPT_BYTE_CEILING");
    attemptReservedBytes.add(fixture.length); objectAttempts.add(1);
    const response = request("GET", object.url, null, null, "GET object ORIGINAL", 200, true, true);
    const body = response?.body;
    const length = body instanceof ArrayBuffer ? body.byteLength : 0;
    attemptReturnedBytes.add(length);
    if (length < fixture.length) partialReturnedBytes.add(length);
    // Even an errored HTTP200 cannot turn an oversized or full corrupt body into a retry.
    requireValue(length <= fixture.length, "BODY_LENGTH_MISMATCH");
    if (length === fixture.length)
      requireValue(crypto.sha256(body, "base64") === fixture.checksum, "BODY_HASH_MISMATCH");
    const transport = !response || response.status === 0 ||
      typeof response.error_code === "number" && response.error_code !== 0 && !(response.error_code >= 1400 && response.error_code <= 1599);
    const reason = transport ? "transport" : response.status === 401 ? "http_401" :
      response.status === 403 ? "http_403" : response.status === 429 ? "http_429" :
      response.status >= 500 && response.status <= 599 ? "http_5xx" : length < fixture.length ? "short_body" : null;
    if (!reason) {
      received.add(length, { variant: "ORIGINAL" });
      if (attempt > 1) recoveredCopies.add(1);
      return;
    }
    retryableFailures.add(1); RETRY_REASON_COUNTS[reason].counter.add(1);
    if (attempt === 3) stop("OBJECT_RETRY_EXHAUSTED");
  }
}

function put(object, variant) {
  const fixture = fixtures[variant];
  const headers = object.requiredHeaders;
  requireValue(
    object.variant === variant &&
      !object.uploadedEtag &&
      headers &&
      Object.keys(headers).length === 4 &&
      headers["content-length"] === String(fixture.length) &&
      headers["content-type"] === "application/octet-stream" &&
      headers["x-amz-checksum-sha256"] === fixture.checksum &&
      headers["if-none-match"] === "*",
    "UPLOAD_GRANT_INVALID",
  );
  sentBytes += fixture.length;
  requireValue(
    sentBytes <= PHOTOS * (ORIGINAL_BYTES + PREVIEW_BYTES),
    "UPLOAD_BYTE_CEILING",
  );
  const response = request(
    "PUT",
    object.url,
    { headers, bytes: fixture.bytes },
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
  sent.add(fixture.length, { variant });
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
    encryptedManifest: fixtures.manifest,
    objects: ["PREVIEW", "ORIGINAL"].map((variant) => ({
      variant,
      ciphertextBytes: String(fixtures[variant].length),
      checksumSha256: fixtures[variant].checksum,
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
  const previewEtag = put(preview, "PREVIEW");
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
  const originalEtag = put(original, "ORIGINAL");
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
  // One exact reservation+commit replay for every ten assets, without additional object bytes.
  if (
    (STAGE === "smoke" && owner === 0) ||
    (STAGE === "burst" && photo === 0)
  ) {
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
export default async function scenario(data) {
  await configuration();
  const owner = exec.vu.idInTest - 1;
  requireValue(Number.isInteger(owner) && owner >= 0 && owner < 10 && exec.scenario.iterationInTest < 10, "VU_SCOPE");
  requireValue(data && Number.isFinite(data.startedAt) && data.startedAt <= Date.now() && Array.isArray(data.pendingByActor) && data.pendingByActor.length === 10 && data.expected === Number(RECOVERY.expectedPending) && data.recoveryRunId === RECOVERY.runId && bundle.tripId === RECOVERY.tripId, "RECOVERY_SETUP_REQUIRED");
  deadline = data.startedAt + MAX_MS;
  initFixtures();
  const actor = bundle.actors[owner];
  const expected = data.pendingByActor[owner];
  requireValue(Number.isSafeInteger(expected) && expected >= 0 && expected <= 9 * PHOTOS, "RECOVERY_ACTOR_COUNT_INVALID");
  const initial = transfer(actor);
  requireValue(initial.pendingUploads === 0 && initial.pendingDownloads === expected, "RECOVERY_BASELINE_CHANGED");
  const saved = new Set();
  const deliveryIds = new Set();
  const cursors = new Set();
  let cursor;
  let receiptReplayed = false;
  for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
    const page = pending(actor, cursor);
    for (const item of page.items) {
      requireValue(item.tripId === bundle.tripId && UUID.test(item.deliveryId), "FOREIGN_DELIVERY");
      validAsset(item.assetId, item.sourceDeviceId);
      requireValue(item.sourceDeviceId !== actor.deviceId && !saved.has(item.assetId) && !deliveryIds.has(item.deliveryId) && saved.size < expected, "DUPLICATE_OR_SOURCE_PENDING");
      const prefix = `recovery:${data.recoveryRunId}:${owner}:${item.deliveryId}`;
      const receiptStarted = Date.now();
      downloadWithRetry(actor, item, prefix); // full length+SHA before ANY receipt
      const body = { assetId: item.assetId, savedAt: new Date().toISOString(), engineRevision: 1 };
      const receipt = post(`/v1/deliveries/${item.deliveryId}/saved-receipt`, body, actor, `${prefix}:receipt`, "POST harness receipt");
      requireValue(receipt.deliveryId === item.deliveryId && receipt.status === "SAVED_LOCALLY" && date(receipt.acceptedAt) > 0, "RECEIPT_INVALID");
      if (!receiptReplayed) {
        // Identical label, savedAt, and payload. No new acknowledgement identity.
        const again = post(`/v1/deliveries/${item.deliveryId}/saved-receipt`, body, actor, `${prefix}:receipt`, "POST receipt replay");
        requireValue(again.deliveryId === receipt.deliveryId && again.status === receipt.status && again.acceptedAt === receipt.acceptedAt, "RECEIPT_REPLAY_CHANGED");
        replays.add(1); receiptReplayed = true;
      }
      saved.add(item.assetId); deliveryIds.add(item.deliveryId);
      receipts.add(1); receiptMs.add(Date.now() - receiptStarted);
    }
    if (!page.hasMore) { requireValue(page.nextCursor === null, "PENDING_PAGINATION_INVALID"); break; }
    requireValue(pageIndex < 1 && !cursors.has(page.nextCursor), "PENDING_PAGE_OR_CURSOR_CEILING");
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  requireValue(saved.size === expected && (expected === 0 || receiptReplayed), "RECOVERY_DRAIN_INCOMPLETE");
  const remaining = pending(actor);
  requireValue(remaining.items.length === 0 && remaining.hasMore === false && remaining.nextCursor === null, "RECOVERY_FINAL_PENDING_NOT_EMPTY");
  const state = transfer(actor);
  requireValue(state.pendingUploads === 0 && state.pendingDownloads === 0, "FINAL_QUEUE_NOT_EMPTY");
  drainMs.add(Date.now() - data.startedAt); actorsDone.add(1);
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
  "crewroll_control_full_body_ms",
  "crewroll_object_full_body_ms",
  "crewroll_capture_to_commit_ms",
  "crewroll_commit_to_discovery_ms",
  "crewroll_download_to_harness_receipt_ms",
  "crewroll_actor_drain_ms",
  "crewroll_future_server_timestamp_samples",
  "crewroll_resilience_object_attempts",
  "crewroll_resilience_retry_attempts",
  "crewroll_resilience_retryable_failures",
  "crewroll_resilience_recovered_copies",
  "crewroll_resilience_attempt_reserved_bytes",
  "crewroll_resilience_returned_body_bytes",
  "crewroll_resilience_partial_body_bytes",
  "crewroll_resilience_backoff_seconds",
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
    crewroll_commits: 0,
    crewroll_harness_receipts: Number(RECOVERY.expectedPending),
    crewroll_ciphertext_uploaded_bytes: 0,
    crewroll_ciphertext_downloaded_bytes:
      Number(RECOVERY.expectedPending) * ORIGINAL_BYTES,
  };
  const complete = Object.entries(expected).every(
    ([name, value]) => metrics[name].count === value,
  );
  const thresholdPass = Object.values(data.metrics).every((metric) =>
    Object.values(metric.thresholds || {}).every(
      (threshold) => threshold.ok === true,
    ),
  );
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
    stage: "resilience-of-existing-burst",
    strictRecoveryRemainsFailed: true,
    objectAttemptsPerCopyMaximum: 3,
    objectRetryBackoffSeconds: [4, 8],
    objectFullBodyTimeoutSeconds: 30,
    scenarioMaximumSeconds: 1200,
    outerProcessMaximumSeconds: 1050,
    workflowJobMaximumSeconds: 1200,
    requestCapPerActor: REQUEST_CAP,
    totalRequestCapIncludingSetup: 10 * REQUEST_CAP + 41,
    maximumReservedObjectBytes: Number(RECOVERY.expectedPending) * 3 * ORIGINAL_BYTES,
    partialBytesAreReturnedBodyOnly: true,
    noControlMutationRetries: true,
    originalBenchmarkRemainsFailed: true,
    deliberateInterruptionVerifiedByK6: false,
    independentDatabasePostflightRequired: true,
    deploymentSha: /^[a-f0-9]{40}$/.test(__ENV.CREWROLL_AUDITED_SHA || "")
      ? __ENV.CREWROLL_AUDITED_SHA
      : null,
    passed:
      complete &&
      thresholdPass &&
      metrics.crewroll_resilience_object_attempts.count >= Number(RECOVERY.expectedPending) &&
      metrics.crewroll_resilience_object_attempts.count <= 3 * Number(RECOVERY.expectedPending) &&
      metrics.crewroll_resilience_retry_attempts.count === metrics.crewroll_resilience_object_attempts.count - Number(RECOVERY.expectedPending) &&
      metrics.crewroll_resilience_retryable_failures.count === metrics.crewroll_resilience_retry_attempts.count &&
      metrics.crewroll_resilience_attempt_reserved_bytes.count === metrics.crewroll_resilience_object_attempts.count * ORIGINAL_BYTES &&
      metrics.crewroll_resilience_backoff_seconds.count <= 12 * Number(RECOVERY.expectedPending) &&
      (metrics.crewroll_assertion_failures.count || 0) === 0,
    scriptSha256: /^[a-f0-9]{64}$/.test(__ENV.CREWROLL_SCRIPT_SHA256 || "")
      ? __ENV.CREWROLL_SCRIPT_SHA256
      : null,
    nativePhotoEvidence: false,
    indiaNetworkEvidence: false,
    metrics,
    controlRoutes: routes,
    routeRequestCounts: routeCounts,
    routeUnexpectedStatusCounts,
    routeTransportCounts,
    failureCodeCounts: diagnosticCounts(FAILURE_COUNTS),
    retryableObjectFailureCounts: diagnosticCounts(RETRY_REASON_COUNTS),
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
