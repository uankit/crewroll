// Same existing READY synthetic original; manual bounded diagnostic, no uploads/receipts.
import https from "node:https";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const POLICY = Object.freeze({
  origin: "https://crewroll-api-production.uankitu.workers.dev",
  copies: 10,
  bytes: 4194304,
  controlMs: 20000,
  strictMs: 30000,
  observationMs: 60000,
  runMs: 85000,
  controlBytes: 262144,
});
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CAPABILITY =
  /^https:\/\/crewroll-api-production\.uankitu\.workers\.dev\/v1\/media\/object\?grant=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ABORT_ERR",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const STATUS_CODES = new Set([
  0, 200, 400, 401, 403, 404, 409, 410, 412, 413, 429, 500, 502, 503, 504,
]);
const COLOS = new Set([
  "BOM",
  "DEL",
  "HYD",
  "MAA",
  "CCU",
  "AMD",
  "BLR",
  "SIN",
  "HKG",
  "NRT",
  "ICN",
  "IAD",
  "ORD",
  "DFW",
  "SJC",
  "SFO",
  "LAX",
  "SEA",
  "EWR",
  "ATL",
  "MIA",
  "CDG",
  "FRA",
  "LHR",
  "AMS",
  "YYZ",
  "SYD",
]);
const MILESTONES = Array.from({ length: 8 }, (_, i) => (i + 1) * 524288);
const round = (n) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : null);
const safeError = (e) => (ERROR_CODES.has(e?.code) ? e.code : "UNKNOWN"); // Never read error message/stack/cause.
const sourceSha = () =>
  createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex");
function validInput(input, now) {
  return (
    input &&
    input.purpose === "crewroll-stream-diagnostic-only" &&
    input.origin === POLICY.origin &&
    /^[a-f0-9]{40}$/.test(input.deploymentSha || "") &&
    [
      input.tripId,
      input.assetId,
      input.deliveryId,
      input.actor?.deviceId,
    ].every((v) => typeof v === "string" && UUID.test(v)) &&
    /^[a-f0-9]{64}$/.test(input.expectedSha256 || "") &&
    typeof input.actor.backgroundBearer === "string" &&
    input.actor.backgroundBearer.length >= 32 &&
    input.actor.backgroundBearer.length <= 4096 &&
    !/[\s\r\n]/.test(input.actor.backgroundBearer) &&
    typeof input.expiresAt === "string" &&
    Date.parse(input.expiresAt) > now + 120000
  );
}
function requestOnce({
  url,
  method = "GET",
  headers = {},
  payload,
  limitMs,
  deadlineKind,
  binary = false,
  expectedHash,
  ports,
}) {
  const start = ports.now();
  return new Promise((resolveResult) => {
    let request,
      response,
      timer,
      strictTimer,
      settled = false,
      bytes = 0,
      chunks = 0,
      headersAt = null,
      firstAt = null,
      lastAt = null,
      maxGap = 0;
    let dnsAt = null,
      tcpAt = null,
      tlsAt = null,
      contentLengthBytes = null,
      chunkedTransfer = false,
      encodingIdentity = true,
      cacheNoStore = false,
      colo = "unknown",
      placementType = "unknown",
      placementColo = "unknown";
    let snapshot = null,
      status = 0,
      protocol = "unknown",
      complete = false;
    const milestones = MILESTONES.map((bytes) => ({ bytes, atMs: null }));
    const hash = binary ? createHash("sha256") : null;
    const body = [];
    const phase = () =>
      headersAt === null
        ? "BEFORE_HEADERS"
        : firstAt === null
          ? "WAITING_FIRST_CHUNK"
          : "RECEIVING";
    const finish = (reason, errorCode = "NONE") => {
      if (settled) return;
      settled = true;
      ports.cancel(timer);
      ports.cancel(strictTimer);
      const duration = ports.now() - start;
      const full = reason === "COMPLETE";
      resolveResult({
        reason,
        errorCode,
        status,
        protocol,
        contentLengthBytes,
        chunkedTransfer,
        encodingIdentity,
        cacheNoStore,
        colo,
        placementType,
        placementColo,
        dnsAtMs: round(dnsAt),
        tcpAtMs: round(tcpAt),
        tlsAtMs: round(tlsAt),
        bytesReceived: bytes,
        chunkCount: chunks,
        headersAtMs: round(headersAt),
        firstChunkAtMs: round(firstAt),
        lastChunkAtMs: round(lastAt),
        maxInterChunkGapMs: round(maxGap),
        terminalIdleMs: round(ports.now() - start - (lastAt ?? headersAt ?? 0)),
        durationMs: round(duration),
        messageComplete: complete,
        fullHashMatch: binary ? full : null,
        completedWithin30s: full && duration <= POLICY.strictMs,
        strict30Miss: !full || duration > POLICY.strictMs,
        at30: snapshot ?? {
          observed: false,
          bytesReceived: bytes,
          phase: full ? "COMPLETE_BEFORE_30S" : "TERMINAL_BEFORE_30S",
          idleMs: round(ports.now() - start - (lastAt ?? headersAt ?? 0)),
        },
        milestones,
        ...(!binary && full
          ? { privateBody: Buffer.concat(body).toString("utf8") }
          : {}),
      });
    };
    const terminate = (reason) => {
      finish(reason);
      request?.destroy();
      response?.destroy();
    };
    try {
      // agent:false creates a new socket for every copy. Native HTTPS is HTTP/1.1.
      request = ports.request(
        url,
        { method, agent: false, headers },
        (incoming) => {
          response = incoming;
          headersAt = ports.now() - start;
          status = STATUS_CODES.has(incoming.statusCode)
            ? incoming.statusCode
            : 0;
          const length = incoming.headers["content-length"];
          contentLengthBytes =
            typeof length === "string" &&
            /^(?:0|[1-9][0-9]{0,8})$/.test(length) &&
            Number(length) <= 8388608
              ? Number(length)
              : null;
          chunkedTransfer =
            typeof incoming.headers["transfer-encoding"] === "string" &&
            /(?:^|,)\s*chunked(?:,|$)/i.test(
              incoming.headers["transfer-encoding"],
            );
          encodingIdentity =
            !incoming.headers["content-encoding"] ||
            incoming.headers["content-encoding"] === "identity";
          cacheNoStore =
            typeof incoming.headers["cache-control"] === "string" &&
            incoming.headers["cache-control"]
              .split(",")
              .some((v) => v.trim() === "no-store");
          const ray =
            typeof incoming.headers["cf-ray"] === "string"
              ? /^[a-f0-9]{16}-([A-Z]{3})$/.exec(incoming.headers["cf-ray"])
              : null;
          colo = ray && COLOS.has(ray[1]) ? ray[1] : "unknown";
          const placement =
            typeof incoming.headers["cf-placement"] === "string"
              ? /^(local|remote)-([A-Z]{3})$/.exec(
                  incoming.headers["cf-placement"],
                )
              : null;
          if (placement && COLOS.has(placement[2])) {
            placementType = placement[1];
            placementColo = placement[2];
          }
          protocol =
            incoming.httpVersion === "1.1"
              ? "h1"
              : incoming.httpVersion === "2.0"
                ? "h2"
                : "unknown";
          if (incoming.statusCode !== 200 || incoming.headers.location) {
            terminate("HTTP_REJECTED");
            return;
          }
          if (protocol !== "h1") {
            terminate("PROTOCOL_REJECTED");
            return;
          }
          if (!binary && incoming.headers["cache-control"] !== "no-store") {
            terminate("CONTROL_CACHE_REJECTED");
            return;
          }
          if (
            binary &&
            incoming.headers["content-length"] !== undefined &&
            incoming.headers["content-length"] !== String(POLICY.bytes)
          ) {
            terminate("DECLARED_LENGTH_REJECTED");
            return;
          }
          if (
            binary &&
            incoming.headers["content-encoding"] &&
            incoming.headers["content-encoding"] !== "identity"
          ) {
            terminate("CONTENT_ENCODING_REJECTED");
            return;
          }
          incoming.on("data", (chunk) => {
            if (settled) return;
            if (!Buffer.isBuffer(chunk)) {
              terminate("BODY_TYPE_REJECTED");
              return;
            }
            const at = ports.now() - start;
            maxGap = Math.max(maxGap, at - (lastAt ?? headersAt));
            firstAt ??= at;
            lastAt = at;
            chunks++;
            bytes += chunk.length;
            if (bytes > (binary ? POLICY.bytes : POLICY.controlBytes)) {
              terminate("BODY_OVERSIZE");
              return;
            }
            if (binary) {
              hash.update(chunk);
              for (const m of milestones)
                if (m.atMs === null && bytes >= m.bytes) m.atMs = round(at);
            } else body.push(chunk);
          });
          incoming.on("end", () => {
            if (settled) return;
            complete = incoming.complete === true;
            if (!complete) {
              finish("MESSAGE_INCOMPLETE");
              return;
            }
            if (binary && bytes !== POLICY.bytes) {
              finish("BODY_SHORT");
              return;
            }
            if (binary && hash.digest("hex") !== expectedHash) {
              finish("BODY_HASH_MISMATCH");
              return;
            }
            finish("COMPLETE");
          });
          incoming.on("error", (e) => finish("STREAM_ERROR", safeError(e)));
          incoming.on("close", () => {
            if (!settled) finish("STREAM_CLOSED");
          });
        },
      );
      request.on("socket", (socket) => {
        socket.once("lookup", () => {
          dnsAt = ports.now() - start;
        });
        socket.once("connect", () => {
          tcpAt = ports.now() - start;
        });
        socket.once("secureConnect", () => {
          tlsAt = ports.now() - start;
        });
      });
      request.on("error", (e) => finish("REQUEST_ERROR", safeError(e)));
      timer = ports.schedule(
        () => terminate(deadlineKind),
        Math.max(1, limitMs),
      );
      if (binary && limitMs > POLICY.strictMs)
        strictTimer = ports.schedule(() => {
          snapshot = {
            observed: true,
            bytesReceived: bytes,
            phase: phase(),
            idleMs: round(ports.now() - start - (lastAt ?? headersAt ?? 0)),
          };
        }, POLICY.strictMs);
      request.end(payload);
    } catch {
      terminate("REQUEST_CONSTRUCTION_ERROR");
    }
  });
}
function publicAttempt(value, ordinal) {
  const { privateBody, ...safe } = value;
  return { ordinal, ...safe };
}
export async function runDiagnostic(
  input,
  {
    host = "mac",
    request = https.request,
    now = () => performance.now(),
    wallNow = () => Date.now(),
    schedule = setTimeout,
    cancel = clearTimeout,
  } = {},
) {
  const ports = { request, now, schedule, cancel };
  const started = now();
  const attempts = [];
  const controlResults = [];
  let controls = 0;
  const runtime = process.versions.node.split(".").slice(0, 3).map(Number);
  const result = (reason) => ({
    schemaVersion: 1,
    nodeMajor: runtime[0],
    nodeMinor: runtime[1],
    nodePatch: runtime[2],
    purpose: "bounded-original-stream-observation",
    host: host === "github" ? "github" : "mac",
    scriptSha256: sourceSha(),
    deploymentSha: /^[a-f0-9]{40}$/.test(input?.deploymentSha || "")
      ? input.deploymentSha
      : null,
    assetOrdinal: 1,
    requestCeiling: 12,
    originalGetCeiling: 10,
    maximumRequestedOriginalBytes: 41943040,
    originalGetStarts: attempts.length,
    normalControlStarts: controls,
    normalControlResults: controlResults,
    uploadRequests: 0,
    receiptRequests: 0,
    observationCeilingMs: 60000,
    strictDeadlineMs: 30000,
    runCeilingMs: 85000,
    reason,
    completedHashCopies: attempts.filter((a) => a.fullHashMatch).length,
    strict30PassedCopies: attempts.filter((a) => a.completedWithin30s).length,
    strict30Misses: attempts.filter((a) => a.strict30Miss).length,
    allTenHashCopies:
      attempts.length === 10 && attempts.every((a) => a.fullHashMatch),
    original100BenchmarkRemainsFailed: true,
    original100RecoveryRemainsFailed: true,
    cellStrict30Passed:
      attempts.length === 10 && attempts.every((a) => a.completedWithin30s),
    strict30BenchmarkPassed:
      attempts.length === 10 && attempts.every((a) => a.completedWithin30s),
    attempts,
    durationMs: round(now() - started),
    nativePhotoEvidence: false,
  });
  if (runtime[0] !== 22 || runtime[1] !== 14 || runtime[2] !== 0)
    return result("NODE_VERSION_REJECTED");
  if (!validInput(input, wallNow()) || !["mac", "github"].includes(host))
    return result("INPUT_REJECTED");
  const actor = input.actor;
  const auth = {
    Authorization: `Bearer ${actor.backgroundBearer}`,
    "X-CrewRoll-Device-Id": actor.deviceId,
    "Accept-Encoding": "identity",
    Connection: "close",
  };
  const control = async (path, payload) => {
    const remaining = POLICY.runMs - (now() - started);
    if (remaining <= 0) return null;
    controls++;
    const value = await requestOnce({
      url: POLICY.origin + path,
      method: payload ? "POST" : "GET",
      headers: payload
        ? {
            ...auth,
            "Content-Type": "application/json",
            "Idempotency-Key": randomUUID(),
          }
        : auth,
      payload: payload ? JSON.stringify(payload) : undefined,
      limitMs: Math.min(POLICY.controlMs, remaining),
      deadlineKind:
        remaining < POLICY.controlMs ? "RUN_DEADLINE" : "CONTROL_DEADLINE",
      ports,
    });
    controlResults.push(publicAttempt(value, controls));
    if (value.reason !== "COMPLETE") return null;
    try {
      return JSON.parse(value.privateBody);
    } catch {
      return null;
    }
  };
  const pending = await control(
    `/v1/deliveries/pending?tripId=${input.tripId}`,
  );
  if (
    !pending ||
    !Array.isArray(pending.items) ||
    pending.items.length > 100 ||
    !pending.items.some(
      (x) =>
        x.deliveryId === input.deliveryId &&
        x.assetId === input.assetId &&
        x.tripId === input.tripId &&
        UUID.test(x.sourceDeviceId || "") &&
        x.sourceDeviceId !== actor.deviceId,
    )
  )
    return result("PENDING_SCOPE_REJECTED");
  const grant = await control(
    `/v1/deliveries/${input.deliveryId}/download-session`,
    { variants: ["ORIGINAL"] },
  );
  const object = grant?.objects?.[0];
  let checksum;
  try {
    checksum = Buffer.from(object?.checksumSha256 || "", "base64");
  } catch {}
  if (
    !grant ||
    grant.deliveryId !== input.deliveryId ||
    grant.assetId !== input.assetId ||
    !Array.isArray(grant.objects) ||
    grant.objects.length !== 1 ||
    object.variant !== "ORIGINAL" ||
    object.ciphertextBytes !== String(POLICY.bytes) ||
    !checksum ||
    checksum.length !== 32 ||
    checksum.toString("base64") !== object.checksumSha256 ||
    checksum.toString("hex") !== input.expectedSha256 ||
    typeof object.url !== "string" ||
    object.url.length > 8192 ||
    !CAPABILITY.test(object.url) ||
    typeof grant.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(grant.expiresAt)) ||
    Date.parse(grant.expiresAt) <= wallNow() + 90000
  )
    return result("GRANT_SCOPE_REJECTED");
  // Start all ten without a serial await. No retry, receipt or upload path exists.
  const work = Array.from({ length: POLICY.copies }, async (_, index) => {
    const remaining = POLICY.runMs - (now() - started);
    const value = await requestOnce({
      url: object.url,
      binary: true,
      headers: { "Accept-Encoding": "identity", Connection: "close" },
      expectedHash: input.expectedSha256,
      limitMs: Math.min(POLICY.observationMs, Math.max(1, remaining)),
      deadlineKind:
        remaining < POLICY.observationMs
          ? "RUN_DEADLINE"
          : "OBSERVATION_DEADLINE",
      ports,
    });
    attempts.push(publicAttempt(value, index + 1));
  });
  await Promise.all(work);
  attempts.sort((a, b) => a.ordinal - b.ordinal);
  return result(
    attempts.every((a) => a.fullHashMatch)
      ? "OBSERVATION_COMPLETE"
      : "OBSERVATION_HAS_FAILURES",
  );
}
async function cli() {
  let bytes = 0;
  const pieces = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16384) throw new Error("INPUT_LIMIT");
    pieces.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(pieces).toString("utf8"));
  } catch {
    input = null;
  }
  const host = process.env.CREWROLL_DIAGNOSTIC_HOST;
  if (!["mac", "github"].includes(host)) throw new Error("HOST_INPUT_INVALID");
  const summary = await runDiagnostic(input, { host });
  process.stdout.write(JSON.stringify(summary) + "\n");
  // Later60s success never reclassifies the strict30s benchmark as passed.
  process.exitCode = summary.allTenHashCopies ? 0 : 1;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  cli().catch(() => {
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        purpose: "bounded-original-stream-observation",
        reason: "SAFE_FATAL",
        allTenHashCopies: false,
        strict30BenchmarkPassed: false,
        cellStrict30Passed: false,
        original100BenchmarkRemainsFailed: true,
        original100RecoveryRemainsFailed: true,
      }) + "\n",
    );
    process.exitCode = 1;
  });
