import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { runDiagnostic, POLICY } from "./stream-probe.mjs";
const CANARY = "PRIVATE_TOKEN_URL_ERROR_BODY_NEVER_RETAIN";
const bytes = Buffer.alloc(POLICY.bytes, 7);
const sha = createHash("sha256").update(bytes).digest("hex");
const input = {
  purpose: "crewroll-stream-diagnostic-only",
  origin: POLICY.origin,
  deploymentSha: "a".repeat(40),
  tripId: "01990000-0000-7000-8000-000000000001",
  assetId: "01990000-0000-4000-8000-000000000002",
  deliveryId: "01990000-0000-4000-8000-000000000003",
  actor: {
    deviceId: "01990000-0000-4000-8000-000000000004",
    backgroundBearer: CANARY,
  },
  expectedSha256: sha,
  expiresAt: "2030-01-01T00:00:00.000Z",
};
function fixture(mode = "fast") {
  let tick = 0,
    sequence = 0,
    active = 0,
    maxActive = 0,
    getStarts = 0;
  const jobs = new Map(),
    calls = [];
  const schedule = (fn, delay) => {
    const id = ++sequence;
    jobs.set(id, { at: tick + delay, fn });
    return id;
  };
  const cancel = (id) => jobs.delete(id);
  const later = (req, fn, ms) =>
    schedule(() => {
      if (!req.dead) fn();
    }, ms);
  const request = (url, options, callback) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, method: options.method });
    assert.equal(parsed.origin, POLICY.origin);
    assert.equal(options.agent, false);
    const req = new EventEmitter();
    req.dead = false;
    req.original = parsed.pathname === "/v1/media/object";
    const done = () => {
      if (req.original && !req.countedDone) {
        req.countedDone = true;
        active--;
      }
    };
    req.destroy = () => {
      req.dead = true;
      done();
    };
    req.end = (payload) => {
      const res = new EventEmitter();
      res.headers = {};
      res.statusCode = 200;
      res.httpVersion = "1.1";
      res.complete = true;
      res.destroy = () => req.destroy();
      if (!req.original) {
        assert.equal(options.headers.Authorization, `Bearer ${CANARY}`);
        if (mode === "controltimeout") return;
        res.headers["cache-control"] =
          mode === "badcache" ? "private" : "no-store";
        let body;
        if (parsed.pathname === "/v1/deliveries/pending")
          body = {
            items: [
              {
                tripId: input.tripId,
                assetId: input.assetId,
                deliveryId: input.deliveryId,
                sourceDeviceId: "01990000-0000-4000-8000-000000000005",
              },
            ],
            hasMore: false,
            nextCursor: null,
          };
        else {
          assert.equal(options.method, "POST");
          assert.deepEqual(JSON.parse(payload), { variants: ["ORIGINAL"] });
          body = {
            deliveryId: input.deliveryId,
            assetId:
              mode === "wrongscope"
                ? "01990000-0000-4000-8000-000000000099"
                : input.assetId,
            expiresAt:
              mode === "badexpiry" ? "invalid" : "2030-01-01T00:00:00.000Z",
            objects: [
              {
                variant: "ORIGINAL",
                ciphertextBytes: String(POLICY.bytes),
                checksumSha256: Buffer.from(sha, "hex").toString("base64"),
                url: `${POLICY.origin}/v1/media/object?grant=${CANARY}.offline`,
              },
            ],
          };
        }
        later(req, () => callback(res), 0);
        later(
          req,
          () => res.emit("data", Buffer.from(JSON.stringify(body))),
          1,
        );
        later(req, () => res.emit("end"), 2);
        return;
      }
      assert.equal(options.headers.Authorization, undefined);
      getStarts++;
      active++;
      maxActive = Math.max(maxActive, active);
      res.headers["content-length"] = String(POLICY.bytes);
      if (mode === "incomplete") res.complete = false;
      if (mode === "badlength") res.headers["content-length"] = "4194305";
      if (mode === "framing") {
        delete res.headers["content-length"];
        res.headers["transfer-encoding"] = "chunked";
        res.headers["cache-control"] = "private, no-store";
        res.headers["cf-ray"] = "0123456789abcdef-BOM";
        res.headers["cf-placement"] = "remote-ICN";
      }
      if (mode === "http503") res.statusCode = 503;
      if (mode === "redirect") {
        res.statusCode = 302;
        res.headers.location = `https://private.invalid/${CANARY}`;
      }
      later(req, () => callback(res), 10);
      if (mode === "http503" || mode === "redirect") return;
      if (mode === "reset") {
        const error = { code: "ECONNRESET" };
        for (const name of ["message", "stack", "cause"])
          Object.defineProperty(error, name, {
            get() {
              throw new Error(CANARY);
            },
          });
        later(req, () => res.emit("error", error), 300);
        later(req, done, 300);
        return;
      }
      let body = bytes;
      if (mode === "short") body = bytes.subarray(0, bytes.length - 1);
      if (mode === "corrupt") {
        body = Buffer.from(bytes);
        body[991] ^= 1;
      }
      if (mode === "overrun") body = Buffer.concat([bytes, Buffer.from([1])]);
      let offset = 0,
        part = 0;
      // Varied boundaries cross milestones, exercising cumulative counts instead of chunk count assumptions.
      const lengths =
        mode === "slow" || mode === "idle"
          ? Array(8).fill(524288)
          : [1, 17, 524281, 65537, 1048577, 32769, 1000001, 1523121];
      for (const proposed of lengths) {
        if (offset >= body.length) break;
        const len = Math.min(proposed, body.length - offset);
        const piece = body.subarray(offset, offset + len);
        offset += len;
        const at =
          mode === "slow"
            ? 1000 + part * 6000
            : mode === "idle"
              ? part === 0
                ? 1000
                : 61000 + part
              : 20 + part;
        later(req, () => res.emit("data", piece), at);
        part++;
      }
      if (offset < body.length) {
        const piece = body.subarray(offset);
        later(
          req,
          () => res.emit("data", piece),
          mode === "slow" ? 44000 : mode === "idle" ? 62000 : 40,
        );
      }
      later(
        req,
        () => {
          res.emit("end");
          done();
        },
        mode === "slow" ? 45000 : mode === "idle" ? 63000 : 50,
      );
    };
    return req;
  };
  return {
    ports: {
      request,
      now: () => tick,
      wallNow: () => 1700000000000,
      schedule,
      cancel,
    },
    calls,
    counts: () => ({ getStarts, maxActive, active }),
    async flush(promise) {
      let answer, failed;
      promise.then(
        (v) => {
          answer = v;
        },
        (e) => {
          failed = e;
        },
      );
      for (
        let step = 0;
        step < 10000 && answer === undefined && !failed;
        step++
      ) {
        await Promise.resolve();
        if (answer !== undefined) break;
        const next = [...jobs].sort(
          (a, b) => a[1].at - b[1].at || a[0] - b[0],
        )[0];
        if (!next) continue;
        jobs.delete(next[0]);
        tick = next[1].at;
        next[1].fn();
      }
      if (failed) throw failed;
      assert.ok(answer, "offline event queue completed");
      return answer;
    },
  };
}
for (const mode of [
  "fast",
  "slow",
  "idle",
  "short",
  "corrupt",
  "overrun",
  "reset",
  "http503",
  "redirect",
  "wrongscope",
  "badexpiry",
  "incomplete",
  "badlength",
  "framing",
])
  test(`actual stream state machine: ${mode}`, async () => {
    const f = fixture(mode);
    const result = await f.flush(runDiagnostic(input, f.ports));
    const encoded = JSON.stringify(result);
    assert.ok(!encoded.includes(CANARY));
    assert.ok(!encoded.includes("https://"));
    assert.equal(result.original100BenchmarkRemainsFailed, true);
    assert.equal(result.original100RecoveryRemainsFailed, true);
    assert.equal(result.cellStrict30Passed, result.strict30BenchmarkPassed);
    assert.equal(result.uploadRequests, 0);
    assert.equal(result.receiptRequests, 0);
    assert.equal(result.normalControlStarts, 2);
    assert.ok(
      result.normalControlResults.every((x) => x.fullHashMatch === null),
    );
    assert.ok(
      f.calls.every(
        (x) => !x.path.endsWith("saved-receipt") && !x.path.includes("upload"),
      ),
    );
    if (mode === "wrongscope" || mode === "badexpiry") {
      assert.equal(f.counts().getStarts, 0);
      assert.equal(result.reason, "GRANT_SCOPE_REJECTED");
      return;
    }
    assert.equal(f.counts().getStarts, 10);
    assert.equal(f.counts().maxActive, 10);
    assert.equal(result.originalGetStarts, 10);
    assert.equal(f.calls.length, 12);
    assert.equal(result.attempts.length, 10);
    if (mode === "fast" || mode === "framing") {
      assert.equal(result.allTenHashCopies, true);
      assert.equal(result.strict30BenchmarkPassed, true);
      if (mode === "framing")
        assert.ok(
          result.attempts.every(
            (x) =>
              x.contentLengthBytes === null &&
              x.chunkedTransfer &&
              x.cacheNoStore &&
              x.encodingIdentity &&
              x.colo === "BOM" &&
              x.placementType === "remote" &&
              x.placementColo === "ICN",
          ),
        );
      assert.ok(
        result.attempts.every((x) =>
          x.milestones.every((m) => m.atMs !== null),
        ),
      );
    } else if (mode === "slow") {
      assert.equal(result.allTenHashCopies, true);
      assert.equal(result.strict30BenchmarkPassed, false);
      assert.equal(result.strict30Misses, 10);
      assert.ok(
        result.attempts.every(
          (x) =>
            x.at30.observed &&
            x.at30.bytesReceived === 5 * 524288 &&
            x.durationMs === 45000,
        ),
      );
    } else {
      assert.equal(result.allTenHashCopies, false);
      assert.equal(result.strict30BenchmarkPassed, false);
      if (mode === "idle")
        assert.ok(
          result.attempts.every(
            (x) =>
              x.reason === "OBSERVATION_DEADLINE" &&
              x.durationMs === 60000 &&
              x.at30.bytesReceived === 524288,
          ),
        );
      if (mode === "reset")
        assert.ok(result.attempts.every((x) => x.errorCode === "ECONNRESET"));
    }
  });
test("bad input never opens a socket", async () => {
  const f = fixture();
  const r = await runDiagnostic(
    { ...input, origin: "https://foreign.invalid" },
    f.ports,
  );
  assert.equal(r.reason, "INPUT_REJECTED");
  assert.equal(f.calls.length, 0);
});

for (const mode of ["controltimeout", "badcache"])
  test(`control failure stops before grant and originals: ${mode}`, async () => {
    const f = fixture(mode);
    const result = await f.flush(runDiagnostic(input, f.ports));
    assert.equal(result.normalControlStarts, 1);
    assert.equal(result.originalGetStarts, 0);
    assert.equal(f.counts().getStarts, 0);
    assert.equal(
      result.normalControlResults[0].reason,
      mode === "controltimeout" ? "CONTROL_DEADLINE" : "CONTROL_CACHE_REJECTED",
    );
  });
test("CLI host must be explicit; valid GitHub label is preserved without opening network on invalid auth", () => {
  const url = new URL("./stream-probe.mjs", import.meta.url);
  for (const host of [undefined, "github"]) {
    const env = {
      PATH: "/usr/bin:/bin",
      ...(host ? { CREWROLL_DIAGNOSTIC_HOST: host } : {}),
    };
    const child = spawnSync(process.execPath, [url.pathname], {
      input: "{}",
      env,
      encoding: "utf8",
      timeout: 2000,
    });
    assert.equal(child.status, 1);
    const result = JSON.parse(child.stdout);
    assert.equal(result.reason, host ? "INPUT_REJECTED" : "SAFE_FATAL");
    if (host) assert.equal(result.host, "github");
    assert.ok(!child.stdout.includes(CANARY));
  }
});
