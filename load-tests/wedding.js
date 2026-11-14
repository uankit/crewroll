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
const MAX_MS = STAGE === "smoke" ? 300000 : 900000;
const REQUEST_CAP = STAGE === "smoke" ? 150 : 550; // per VU, plus <=41 setup requests
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

export const options = {
  scenarios: {
    wedding: {
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 1,
      maxDuration: STAGE === "smoke" ? "5m" : "15m",
      gracefulStop: "0s",
    },
  },
  setupTimeout: "2m",
  maxRedirects: 0,
  throw: true, // Catch network exceptions ourselves; do not let k6 warn with capability URLs.
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
    crewroll_commits: [`count==${10 * PHOTOS}`],
    crewroll_harness_receipts: [`count==${90 * PHOTOS}`],
    crewroll_ciphertext_uploaded_bytes: [
      `count==${10 * PHOTOS * (ORIGINAL_BYTES + PREVIEW_BYTES)}`,
    ],
    crewroll_ciphertext_downloaded_bytes: [
      `count==${90 * PHOTOS * (ORIGINAL_BYTES + PREVIEW_BYTES)}`,
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
  failures.add(1, { reason: code }); // All callers supply fixed, credential-free reason codes.
  exec.test.abort(code);
  throw new Error(code);
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
    throw: true,
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
    STATUS_COUNTS.transport.counter.add(1);
    return stop("TRANSPORT_FAILURE");
  } // Never stringify the exception or response.
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
  fixtures.manifest = encoding.b64encode(bytes(256, "manifest"), "std");
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
function download(grant, variant) {
  const fixture = fixtures[variant];
  liveUntil(grant.expiresAt);
  requireValue(
    grant.encryptedManifest === fixtures.manifest,
    "MANIFEST_MISMATCH",
  );
  const object =
    variant === "PREVIEW" ? grant.object : grant.objects && grant.objects[0];
  requireValue(
    object &&
      object.variant === variant &&
      object.ciphertextBytes === String(fixture.length) &&
      object.checksumSha256 === fixture.checksum &&
      CAPABILITY.test(object.url),
    "DOWNLOAD_GRANT_INVALID",
  );
  downloadReserved += fixture.length;
  requireValue(
    downloadReserved <= 9 * PHOTOS * (ORIGINAL_BYTES + PREVIEW_BYTES),
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
      response.body.byteLength === fixture.length,
    "BODY_LENGTH_MISMATCH",
  );
  requireValue(
    crypto.sha256(response.body, "base64") === fixture.checksum,
    "BODY_HASH_MISMATCH",
  );
  received.add(response.body.byteLength, { variant });
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
  for (let photo = 0; photo < PHOTOS; photo++) upload(actor, owner, photo);
  // One receiver deliberately waits before polling; this is not a product PAUSE command or OS reconnect.
  if (owner === 9) sleep(10);
  const seenPreviews = new Set();
  const saved = new Set();
  let previewCursor = "0";
  let receiptReplayed = false;
  const expected = 9 * PHOTOS;
  for (
    let pass = 0;
    pass < 45 && (seenPreviews.size < expected || saved.size < expected);
    pass++
  ) {
    for (let pageCount = 0; pageCount < 6; pageCount++) {
      const page = previews(actor, previewCursor);
      for (const item of page.items) {
        validAsset(item.assetId, item.sourceDeviceId);
        requireValue(
          DECIMAL.test(item.sequence) &&
            item.download &&
            item.download.assetId === item.assetId,
          "PREVIEW_ITEM_INVALID",
        );
        if (
          item.sourceDeviceId !== actor.deviceId &&
          !seenPreviews.has(item.assetId)
        ) {
          download(item.download, "PREVIEW");
          seenPreviews.add(item.assetId);
        }
      }
      previewCursor = page.nextCursor;
      if (!page.hasMore) break;
      if (pageCount === 5) stop("PREVIEW_PAGE_CEILING");
    }
    let pendingCursor;
    const cursors = new Set();
    for (let pageCount = 0; pageCount < 2; pageCount++) {
      const page = pending(actor, pendingCursor);
      for (const item of page.items) {
        requireValue(
          item.tripId === bundle.tripId && UUID.test(item.deliveryId),
          "FOREIGN_DELIVERY",
        );
        validAsset(item.assetId, item.sourceDeviceId);
        requireValue(
          item.sourceDeviceId !== actor.deviceId && !saved.has(item.assetId),
          "DUPLICATE_OR_SOURCE_PENDING",
        );
        const discoverLatency = Date.now() - date(item.committedAt);
        if (discoverLatency >= 0) discoveryMs.add(discoverLatency);
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
        const receiptStarted = Date.now();
        download(grant, "ORIGINAL");
        const receiptBody = {
          assetId: item.assetId,
          savedAt: new Date().toISOString(),
          engineRevision: 1,
        };
        const receiptLabel = `receipt:${owner}:${item.deliveryId}`;
        const receipt = post(
          `/v1/deliveries/${item.deliveryId}/saved-receipt`,
          receiptBody,
          actor,
          receiptLabel,
          "POST harness receipt",
        );
        requireValue(
          receipt.deliveryId === item.deliveryId &&
            receipt.status === "SAVED_LOCALLY" &&
            date(receipt.acceptedAt) > 0,
          "RECEIPT_INVALID",
        );
        if (!receiptReplayed) {
          const again = post(
            `/v1/deliveries/${item.deliveryId}/saved-receipt`,
            receiptBody,
            actor,
            receiptLabel,
            "POST receipt replay",
          );
          requireValue(
            again.deliveryId === receipt.deliveryId &&
              again.status === receipt.status &&
              again.acceptedAt === receipt.acceptedAt,
            "RECEIPT_REPLAY_CHANGED",
          );
          receiptReplayed = true;
          replays.add(1);
        }
        saved.add(item.assetId);
        receipts.add(1);
        receiptMs.add(Date.now() - receiptStarted);
      }
      if (!page.hasMore) break;
      requireValue(!cursors.has(page.nextCursor), "PENDING_CURSOR_CYCLE");
      cursors.add(page.nextCursor);
      pendingCursor = page.nextCursor;
      if (pageCount === 1) stop("PENDING_PAGE_CEILING");
    }
    if (owner === 0 && pass % 10 === 0)
      requireValue(
        get("/health/ready", null, "GET readiness").status === "ready",
        "BACKEND_NOT_READY",
      );
    if (seenPreviews.size < expected || saved.size < expected) sleep(1);
  }
  requireValue(
    seenPreviews.size === expected && saved.size === expected,
    "DELIVERY_DRAIN_INCOMPLETE",
  );
  const state = transfer(actor);
  requireValue(
    state.pendingUploads === 0 && state.pendingDownloads === 0,
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
    crewroll_commits: 10 * PHOTOS,
    crewroll_harness_receipts: 90 * PHOTOS,
    crewroll_ciphertext_uploaded_bytes:
      10 * PHOTOS * (ORIGINAL_BYTES + PREVIEW_BYTES),
    crewroll_ciphertext_downloaded_bytes:
      90 * PHOTOS * (ORIGINAL_BYTES + PREVIEW_BYTES),
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
  for (const name of REQUEST_ROUTES) {
    routeCounts[name] =
      numbers(data.metrics[ROUTE_REQUESTS[name].metricName]).count || 0;
    routeUnexpectedStatusCounts[name] =
      numbers(data.metrics[ROUTE_REQUESTS[name].unexpectedStatusMetricName])
        .count || 0;
  }
  const statusCounts = {};
  for (const code of Object.keys(STATUS_COUNTS))
    statusCounts[code] =
      numbers(data.metrics[STATUS_COUNTS[code].metricName]).count || 0;
  const result = {
    schemaVersion: 1,
    execution: "standalone-k6-on-github-standard-runner",
    stage: STAGE,
    deploymentSha: /^[a-f0-9]{40}$/.test(__ENV.CREWROLL_AUDITED_SHA || "")
      ? __ENV.CREWROLL_AUDITED_SHA
      : null,
    passed:
      complete &&
      thresholdPass &&
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
    statusRequestCounts: statusCounts,
  };
  return { "sanitized-summary.json": JSON.stringify(result, null, 2) + "\n" };
}
