import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TableNode, type KyselyPlugin } from "kysely";
import type {
  CommitAssetBody,
  CreateUploadSessionBody,
} from "@crewroll/contracts";
import { createKyselyAccountService } from "../../services/control-plane/src/db/account/kyselyAccountService.js";
import { createKyselyMediaService } from "../../services/control-plane/src/db/media/kyselyMediaService.js";
import type { CiphertextStore } from "../../services/control-plane/src/modules/media/index.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import { createPostgresBarrier } from "./support/postgresBarrier.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
  type PostgresTestContext,
} from "./support/postgres.js";

async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Account race barrier timed out")),
          8_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function gate() {
  let arrived!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered: () => within(entered),
    release,
    async pause() {
      arrived();
      await within(released);
    },
  };
}

/** Pause only after a real SELECT has acquired its row lock, not before SQL runs. */
function afterFirstRead(
  table: "users" | "trips",
  pause: () => Promise<void>,
): KyselyPlugin {
  const queries = new WeakSet<object>();
  let intercepted = false;
  return {
    transformQuery({ node, queryId }) {
      if (
        !intercepted &&
        node.kind === "SelectQueryNode" &&
        node.from?.froms.some(
          (from) => TableNode.is(from) && from.table.identifier.name === table,
        )
      ) {
        intercepted = true;
        queries.add(queryId);
      }
      return node;
    },
    async transformResult({ result, queryId }) {
      if (queries.has(queryId)) await pause();
      return result;
    },
  };
}

function outcomeStatus(
  outcome: PromiseSettledResult<unknown> | undefined,
): string {
  if (outcome?.status === "fulfilled") return "fulfilled";
  const error: unknown = outcome?.reason;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  return `rejected:${typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown"}`;
}

describe.sequential(
  "account authorization locks under cross-member foreign keys",
  () => {
    let context: PostgresTestContext;
    let fixtures: ReturnType<typeof createIdentityTripFixtures>;
    let owner: Awaited<ReturnType<typeof fixtures.user>>;
    let guest: Awaited<ReturnType<typeof fixtures.user>>;
    let ownerDevice: Awaited<ReturnType<typeof fixtures.device>>;
    let guestDevice: Awaited<ReturnType<typeof fixtures.device>>;
    let ownerMembership: Awaited<ReturnType<typeof fixtures.member>>;
    let guestMembership: Awaited<ReturnType<typeof fixtures.member>>;
    let trip: Awaited<ReturnType<typeof fixtures.trip>>;
    let objects: Map<string, { bytes: string; checksum: string; etag: string }>;
    let store: CiphertextStore;
    const now = new Date("2026-08-29T08:01:00.000Z");
    const clock = { now: () => now };
    const account = (db = context.db) =>
      createKyselyAccountService(
        db,
        { delete: async () => {} },
        clock,
        async () => {},
      );

    beforeAll(async () => {
      context = await startMigratedPostgres();
    });
    afterAll(async () => {
      await context?.stop();
    });
    beforeEach(async () => {
      await truncateIdentityTripTables(context.db);
      fixtures = createIdentityTripFixtures(context.db);
      owner = await fixtures.user();
      guest = await fixtures.user();
      ownerDevice = await fixtures.device(owner.id);
      guestDevice = await fixtures.device(guest.id);
      trip = await fixtures.trip(owner.id, {
        state: "ACTIVE",
        started_at: new Date(now.getTime() - 60_000),
        member_count: 2,
      });
      ownerMembership = await fixtures.member(
        trip.id,
        owner.id,
        ownerDevice.id,
        { role: "OWNER" },
      );
      guestMembership = await fixtures.member(
        trip.id,
        guest.id,
        guestDevice.id,
      );
      await fixtures.activeTrip(owner.id, trip.id);
      await fixtures.activeTrip(guest.id, trip.id);
      objects = new Map();
      store = {
        async upload(object) {
          return `https://media.example/${object.key}`;
        },
        async inspect(key) {
          return objects.get(key) ?? null;
        },
        async download(key) {
          return `https://media.example/${key}`;
        },
        async delete(key) {
          objects.delete(key);
        },
      };
    });

    it("persists both simultaneous mutual reports after each real authorization row is locked", async () => {
      const barrier = createPostgresBarrier(2);
      const guarded = () =>
        account(
          context.db.withPlugin(
            afterFirstRead("users", () => within(barrier.arrive())),
          ),
        );
      // Each call needs the other user's FK KEY SHARE after holding its own user lock.
      const outcomes = await Promise.allSettled([
        guarded().report(owner.clerk_subject, {
          tripId: trip.id,
          membershipId: guestMembership.id,
          reason: "PRIVACY",
        }),
        guarded().report(guest.clerk_subject, {
          tripId: trip.id,
          membershipId: ownerMembership.id,
          reason: "PRIVACY",
        }),
      ]);
      expect(outcomes.map(outcomeStatus)).toEqual(["fulfilled", "fulfilled"]);
      const reports = await context.db
        .selectFrom("safety_reports")
        .select(["reporter_user_id", "subject_user_id"])
        .execute();
      expect(reports).toHaveLength(2);
      expect(reports).toEqual(
        expect.arrayContaining([
          { reporter_user_id: owner.id, subject_user_id: guest.id },
          { reporter_user_id: guest.id, subject_user_id: owner.id },
        ]),
      );
    });

    async function preparedUpload() {
      const checksum = createHash("sha256")
        .update("synthetic encrypted object")
        .digest("base64");
      const body: CreateUploadSessionBody = {
        tripId: trip.id,
        assetId: randomUUID(),
        sourceAssetKey: `src_${"A".repeat(32)}`,
        capturedAt: now.toISOString(),
        formatVersion: 1,
        keyEpoch: 1,
        encryptedManifest: Buffer.from("synthetic encrypted manifest").toString(
          "base64",
        ),
        objects: [
          {
            variant: "PREVIEW",
            ciphertextBytes: "26",
            checksumSha256: checksum,
          },
          {
            variant: "ORIGINAL",
            ciphertextBytes: "26",
            checksumSha256: checksum,
          },
        ],
      };
      const source = { userId: owner.id, deviceId: ownerDevice.id };
      const media = createKyselyMediaService(context.db, store, clock);
      const reservation = await media.createUpload(source, body);
      for (const object of reservation.objects)
        objects.set(new URL(object.url).pathname.slice(1), {
          bytes: object.requiredHeaders["content-length"],
          checksum: object.requiredHeaders["x-amz-checksum-sha256"],
          etag: `"${object.variant}"`,
        });
      const commit: CommitAssetBody = {
        uploadSessionId: reservation.uploadSessionId,
        objects: [
          { variant: "PREVIEW", etag: '"PREVIEW"' },
          { variant: "ORIGINAL", etag: '"ORIGINAL"' },
        ],
      };
      return { source, body, commit };
    }

    it.each(["block", "delete"] as const)(
      "serializes %s against real media commit fan-out and retains its access fence",
      async (operation) => {
        const prepared = await preparedUpload();
        const tripHeld = gate();
        const userHeld = gate();
        const media = createKyselyMediaService(
          context.db.withPlugin(afterFirstRead("trips", tripHeld.pause)),
          store,
          clock,
        );
        const guarded = account(
          context.db.withPlugin(afterFirstRead("users", userHeld.pause)),
        );
        // Attach rejection handlers before awaiting gates: old code must report a deadlock, not an unhandled rejection.
        const mediaOutcome = Promise.allSettled([
          media.commit(prepared.source, prepared.body.assetId, prepared.commit),
        ]);
        let accountOutcome:
          Promise<PromiseSettledResult<unknown>[]> | undefined;
        let committed: PromiseSettledResult<unknown>[] = [];
        let changed: PromiseSettledResult<unknown>[] = [];
        try {
          await tripHeld.entered();
          accountOutcome = Promise.allSettled([
            operation === "block"
              ? guarded.block(guest.clerk_subject, {
                  tripId: trip.id,
                  membershipId: ownerMembership.id,
                })
              : guarded.requestDeletion(guest.clerk_subject),
          ]);
          await userHeld.entered();
        } finally {
          // The commit owns trip; the account owns guest. Both now proceed through the actual SQL/FK paths.
          userHeld.release();
          tripHeld.release();
          [committed, changed] = await Promise.all([
            mediaOutcome,
            accountOutcome ?? Promise.resolve([]),
          ]);
        }
        expect(outcomeStatus(committed[0])).toBe("fulfilled");
        expect(outcomeStatus(changed[0])).toBe("fulfilled");
        const deliveries = await context.db
          .selectFrom("deliveries")
          .select(["recipient_user_id", "state"])
          .where("asset_id", "=", prepared.body.assetId)
          .execute();
        expect(deliveries).toHaveLength(2);
        expect(deliveries).toEqual(
          expect.arrayContaining([
            { recipient_user_id: owner.id, state: "SAVED_LOCALLY" },
            { recipient_user_id: guest.id, state: "EXPIRED" },
          ]),
        );
        const member = await context.db
          .selectFrom("trip_members")
          .select("left_at")
          .where("id", "=", guestMembership.id)
          .executeTakeFirstOrThrow();
        expect(member.left_at).not.toBeNull();
        if (operation === "block") {
          expect(
            await context.db.selectFrom("user_blocks").selectAll().execute(),
          ).toHaveLength(1);
          await expect(
            createKyselyMediaService(context.db, store, clock).createUpload(
              { userId: guest.id, deviceId: guestDevice.id },
              { ...prepared.body, assetId: randomUUID() },
            ),
          ).rejects.toMatchObject({ kind: "NOT_FOUND" });
        } else {
          await expect(
            account().policy(guest.clerk_subject),
          ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
          await expect(
            createKyselyMediaService(context.db, store, clock).createUpload(
              { userId: guest.id, deviceId: guestDevice.id },
              { ...prepared.body, assetId: randomUUID() },
            ),
          ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
          expect(
            await context.db
              .selectFrom("account_deletions")
              .select("id")
              .execute(),
          ).toHaveLength(1);
        }
      },
    );
  },
);
