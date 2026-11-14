import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
// Exercise the public k6 helpers through zero-network ports. The opaque bytes
// below test transport/hash ordering, never native Photos or valid encryption.
const source = readFileSync(
  new URL("../load-tests/wedding.js", import.meta.url),
  "utf8",
);
const ORIGIN = "https://crewroll-api-production.uankitu.workers.dev";
const CANARY = "PRIVATE_GRANT_CANARY_MUST_NEVER_APPEAR";
function load() {
  const metrics = new Map();
  let handler = () => {
    throw new Error(CANARY);
  };
  let calls = 0;
  class Metric {
    constructor(name) {
      this.name = name;
      this.samples = [];
      metrics.set(name, this);
    }
    add(value, tags) {
      this.samples.push({ value, tags });
    }
  }
  const context = vm.createContext({
    __ENV: { CREWROLL_STAGE: "burst" },
    http: {
      request: (...args) => {
        calls++;
        return handler(...args);
      },
    },
    crypto: {
      sha256(value, output) {
        return createHash("sha256").update(Buffer.from(value)).digest(output);
      },
    },
    encoding: {},
    exec: {
      vu: { idInTest: 1 },
      scenario: { iterationInTest: 0 },
      test: {
        abort(code) {
          throw new Error(code);
        },
      },
    },
    sleep() {
      throw new Error("NO_SLEEP_ALLOWED");
    },
    Counter: Metric,
    Rate: Metric,
    Trend: Metric,
    ArrayBuffer,
    Uint8Array,
    Date,
  });
  const code = source
    .replace(/^import .*?;\n/gm, "")
    .replace(
      "export default async function scenario",
      "async function scenario",
    )
    .replace(/^export /gm, "");
  vm.runInContext(
    code +
      `\nglobalThis.p={request,download,stop,handleSummary,options,timingBucket:typeof timingBucket==='undefined'?null:timingBucket,setFixture(f){fixtures={ORIGINAL:f,manifest:'opaque'}},setVu(value){exec.vu.idInTest=value}};`,
    context,
  );
  return {
    ...context.p,
    metrics,
    handler(fn) {
      handler = fn;
    },
    calls: () => calls,
    summary() {
      const data = {
        metrics: Object.fromEntries(
          [...metrics].map(([k, m]) => [
            k,
            { values: { count: m.samples.reduce((n, s) => n + s.value, 0) } },
          ]),
        ),
      };
      return JSON.parse(
        context.p.handleSummary(data)["sanitized-summary.json"],
      );
    },
  };
}
function response(status = 200, error_code = 0, body = new ArrayBuffer(0)) {
  const r = {
    status,
    error_code,
    body,
    headers: { "cache-control": "no-store" },
    timings: {
      blocked: 0,
      connecting: 1,
      tls_handshaking: 0,
      sending: 0,
      waiting: 3,
      receiving: 7,
    },
  };
  for (const field of ["error", "url", "request"])
    Object.defineProperty(r, field, {
      get() {
        throw new Error("SENSITIVE_FIELD_WAS_READ");
      },
    });
  return r;
}
const count = (p, name) =>
  p.metrics.get(name).samples.reduce((sum, s) => sum + s.value, 0);
function noLeak(summary) {
  const out = JSON.stringify(summary);
  for (const secret of [
    CANARY,
    "grant=",
    "Bearer ",
    "https://",
    "http://",
    "SENSITIVE_FIELD_WAS_READ",
  ])
    assert.ok(!out.includes(secret), secret);
}
test("fixed request retains strict one-call abort without inspecting exception/error/url text", () => {
  for (const mode of ["throw", "status0", "partial200"]) {
    const p = load();
    p.handler(() => {
      if (mode === "throw") throw new Error(CANARY);
      return response(
        mode === "status0" ? 0 : 200,
        mode === "status0" ? 1050 : 1220,
      );
    });
    assert.throws(
      () =>
        p.request("GET", "/" + CANARY, null, null, "GET object ORIGINAL", 200),
      /TRANSPORT_FAILURE/,
    );
    const s = p.summary();
    assert.equal(p.calls(), 1);
    assert.equal(s.failureCodeCounts.TRANSPORT_FAILURE, 1);
    assert.equal(s.routeTransportCounts["GET object ORIGINAL"], 1);
    assert.equal(s.routeUnexpectedStatusCounts["GET object ORIGINAL"], 0);
    assert.equal(
      s.transportErrorCodeCounts[
        mode === "throw" ? "0" : mode === "status0" ? "1050" : "1220"
      ],
      1,
    );
    assert.equal(s.passed, false);
    noLeak(s);
  }
});
test("production timeouts and finite request limits remain enforced without retry", () => {
  const p = load();
  assert.equal(p.options.throw, true);
  assert.equal(p.options.scenarios.wedding.vus, 10);
  assert.equal(p.options.scenarios.wedding.iterations, 1);
  assert.equal(p.options.scenarios.wedding.maxDuration, "15m");
  assert.equal(p.options.maxRedirects, 0);
  assert.ok(!p.options.systemTags.includes("url"));
  assert.ok(!p.options.systemTags.includes("error"));
  assert.ok(!p.options.systemTags.includes("error_code"));
  assert.equal(
    p.options.thresholds.crewroll_assertion_failures[0].threshold,
    "count==0",
  );
  assert.equal(
    p.options.thresholds.crewroll_control_full_body_ms[0].threshold,
    "p(95)<2000",
  );
  p.handler((method, url, body, params) => {
    assert.equal(params.timeout, params.tags.kind === "object" ? "30s" : "20s");
    assert.equal(params.throw, false);
    assert.equal(params.redirects, 0);
    return response(200);
  });
  p.request(
    "GET",
    ORIGIN + "/v1/media/object?grant=fake.canary",
    null,
    null,
    "GET object ORIGINAL",
    200,
    true,
  );
  for (let i = 1; i < 550; i++)
    p.request("GET", "/health/ready", null, null, "GET readiness", 200);
  assert.equal(p.calls(), 550);
  assert.throws(
    () => p.request("GET", "/health/ready", null, null, "GET readiness", 200),
    /REQUEST_CEILING/,
  );
  assert.equal(p.calls(), 550);
  assert.equal(p.summary().failureCodeCounts.REQUEST_CEILING, 1);
  const setup = load();
  setup.setVu(0);
  setup.handler(() => response(200));
  for (let i = 0; i < 41; i++)
    setup.request("GET", "/health/ready", null, null, "GET readiness", 200);
  assert.throws(
    () =>
      setup.request("GET", "/health/ready", null, null, "GET readiness", 200),
    /REQUEST_CEILING/,
  );
  assert.equal(setup.calls(), 41);
});
test("HTTP errors remain HTTP errors, never transport or false PASS", () => {
  for (const [status, code, failure] of [
    [401, 1401, "AUTH_OR_SCOPE_REJECTED"],
    [409, 1409, "TERMINAL_OR_EXPIRED"],
    [500, 1500, "UNEXPECTED_HTTP_STATUS"],
  ]) {
    const p = load();
    p.handler(() => response(status, code));
    assert.throws(
      () => p.request("GET", "/health/ready", null, null, "GET readiness", 200),
      new RegExp(failure),
    );
    const s = p.summary();
    assert.equal(s.statusRequestCounts.transport, 0);
    assert.equal(s.statusRequestCounts[String(status)], 1);
    assert.equal(s.failureCodeCounts[failure], 1);
    assert.equal(s.passed, false);
    noLeak(s);
  }
});
test("unknown/nonfinite codes and caller failure strings map to finite unknown vocabulary", () => {
  for (const value of [
    undefined,
    null,
    NaN,
    Infinity,
    123456,
    -5,
    1050.5,
    "1050",
  ]) {
    const p = load();
    p.handler(() => response(0, value));
    assert.throws(
      () => p.request("GET", "/health/ready", null, null, "GET readiness", 200),
      /TRANSPORT_FAILURE/,
    );
    const s = p.summary();
    assert.equal(s.transportErrorCodeCounts["0"], 1);
    noLeak(s);
  }
  const p = load();
  assert.throws(() => p.stop(CANARY), /UNKNOWN_FAILURE_CODE/);
  const s = p.summary();
  assert.equal(s.failureCodeCounts.UNKNOWN_FAILURE_CODE, 1);
  noLeak(s);
});
test("elapsed buckets have exact finite boundaries and no exact user/request duration", () => {
  const p = load();
  for (const [n, b] of [
    [0, "lt_1s"],
    [999, "lt_1s"],
    [1000, "1_to_5s"],
    [4999, "1_to_5s"],
    [5000, "5_to_20s"],
    [19999, "5_to_20s"],
    [20000, "20_to_30s"],
    [29999, "20_to_30s"],
    [30000, "gte_30s"],
    [NaN, "unknown"],
    [Infinity, "unknown"],
    [-1, "unknown"],
  ])
    assert.equal(p.timingBucket(n), b);
});
test("seeded varied bodies count downloaded bytes only after intact length and full hash", () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed;
  };
  const cases = 256;
  let success = 0,
    failure = 0;
  const sizes = new Set();
  const modes = [0, 0, 0, 0];
  for (let i = 0; i < cases; i++) {
    const p = load();
    const length = 1 + (random() % 65536);
    sizes.add(length);
    const bytes = Buffer.alloc(length);
    for (let j = 0; j < length; j++) bytes[j] = (i + j * 17) & 255;
    const fixture = {
      bytes: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.length,
      ),
      length,
      checksum: createHash("sha256").update(bytes).digest("base64"),
    };
    p.setFixture(fixture);
    const mode = (random() >>> 16) % 4;
    modes[mode]++;
    let body = Buffer.from(bytes);
    if (mode === 1) body = body.subarray(0, random() % length);
    if (mode === 2) body[random() % length] ^= 1;
    p.handler(() =>
      response(
        mode === 3 ? 0 : 200,
        mode === 3 ? 1220 : 0,
        body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
      ),
    );
    const grant = {
      assetId: "01990000-0000-4000-8000-000000000001",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      encryptedManifest: "opaque",
      objects: [
        {
          variant: "ORIGINAL",
          ciphertextBytes: String(length),
          checksumSha256: fixture.checksum,
          url: ORIGIN + "/v1/media/object?grant=fake.canary",
        },
      ],
    };
    if (mode === 0) {
      p.download(grant, "ORIGINAL");
      success++;
      assert.equal(count(p, "crewroll_ciphertext_downloaded_bytes"), length);
    } else {
      failure++;
      assert.throws(
        () => p.download(grant, "ORIGINAL"),
        /BODY_LENGTH_MISMATCH|BODY_HASH_MISMATCH|TRANSPORT_FAILURE/,
      );
      assert.equal(count(p, "crewroll_ciphertext_downloaded_bytes"), 0);
    }
    assert.equal(p.calls(), 1);
    assert.equal(count(p, "crewroll_harness_receipts"), 0);
    noLeak(p.summary());
  }
  assert.ok(sizes.size > 100);
  assert.ok(success > 0 && failure > 0);
  assert.ok(
    modes.every((n) => n > 30),
    JSON.stringify(modes),
  );
});
