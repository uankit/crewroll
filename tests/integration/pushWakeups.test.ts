import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sql, TableNode, type KyselyPlugin } from "kysely";
import { createKyselyPushWakeRepository } from "../../services/control-plane/src/db/push/kyselyPushWakeRepository.js";
import { createPushWakeDispatcher } from "../../services/control-plane/src/modules/push/dispatchPushWakeups.js";
import { createKyselyTripLifecycle } from "../../services/control-plane/src/db/trips/kyselyTripLifecycle.js";
import { createKyselyAccountService } from "../../services/control-plane/src/db/account/kyselyAccountService.js";
import type { PushSendResult } from "../../services/control-plane/src/modules/push/ports/pushDispatch.js";
import { createIdentityTripFixtures } from "./support/fixtures.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
  type PostgresTestContext,
} from "./support/postgres.js";

describe.sequential("durable per-recipient push wakeups", () => {
  let context: PostgresTestContext;
  let now: Date;
  let recipient: string;
  let recipientUser: string;
  let owner: { userId: string; deviceId: string };
  let fixtures: ReturnType<typeof createIdentityTripFixtures>;
  const tripId = "01990000-0000-7000-8000-000000000001";
  const oldHash = Buffer.alloc(32, 7);
  const newHash = Buffer.alloc(32, 8);
  const clock = { now: () => now };
  const repository = () => createKyselyPushWakeRepository(context.db, clock);
  beforeAll(async () => {
    context = await startMigratedPostgres();
  });
  afterAll(async () => {
    await context?.stop();
  });
  beforeEach(async () => {
    await truncateIdentityTripTables(context.db);
    now = new Date("2026-08-29T08:01:00Z");
    fixtures = createIdentityTripFixtures(context.db);
    const host = await fixtures.user();
    const hostDevice = await fixtures.device(host.id);
    owner = { userId: host.id, deviceId: hostDevice.id };
    await fixtures.trip(host.id, {
      id: tripId,
      state: "ACTIVE",
      started_at: new Date("2026-08-29T08:00:00Z"),
    });
    await fixtures.member(tripId, host.id, hostDevice.id, { role: "OWNER" });
    const member = await fixtures.user();
    recipientUser = member.id;
    const device = await fixtures.device(member.id, {
      platform: "android",
      encrypted_push_token: Buffer.from("encrypted-token"),
      push_token_hash: oldHash,
    });
    recipient = device.id;
    await fixtures.member(tripId, member.id, recipient);
  });

  async function event(createdAt = now, devices = [recipient]) {
    const sequences: string[] = [];
    for (const device of devices) {
      const inbox = await context.db
        .insertInto("inbox_events")
        .values({
          recipient_device_id: device,
          trip_id: tripId,
          event_type: "TRIP_CHANGED",
          aggregate_id: tripId,
          available_at: createdAt,
          created_at: createdAt,
          payload: { status: "ACTIVE" },
        })
        .returning("sequence")
        .executeTakeFirstOrThrow();
      sequences.push(inbox.sequence);
    }
    const id = crypto.randomUUID();
    await context.db
      .insertInto("outbox_events")
      .values({
        id,
        event_type: "trip.changed",
        aggregate_id: tripId,
        dedupe_key: `test:${id}`,
        payload: { tripId, recipientSequences: sequences },
        available_at: createdAt,
        created_at: createdAt,
        published_at: null,
        last_error: null,
      })
      .execute();
    return id;
  }
  async function claimed() {
    const result = await repository().claim();
    if (!result) throw new Error("Expected a claimed wake");
    return result;
  }

  async function events(count: number, devices: string[] = [recipient]) {
    const ids = Array.from({ length: count }, () => crypto.randomUUID());
    const inbox = await context.db
      .insertInto("inbox_events")
      .values(
        ids.flatMap((id) =>
          devices.map((device) => ({
            recipient_device_id: device,
            trip_id: tripId,
            event_type: "TRIP_CHANGED",
            aggregate_id: id,
            available_at: now,
            created_at: now,
            payload: { status: "ACTIVE" },
          })),
        ),
      )
      .returning(["sequence", "aggregate_id"])
      .execute();
    await context.db
      .insertInto("outbox_events")
      .values(
        ids.map((id) => ({
          id,
          event_type: "trip.changed",
          aggregate_id: tripId,
          dedupe_key: `test:${id}`,
          payload: {
            tripId,
            recipientSequences: inbox
              .filter((row) => row.aggregate_id === id)
              .map((row) => row.sequence),
          },
          available_at: now,
          created_at: now,
          published_at: null,
          last_error: null,
        })),
      )
      .execute();
    return ids;
  }
  function dispatcher(
    send = vi
      .fn<() => Promise<PushSendResult>>()
      .mockResolvedValue({ kind: "accepted" }),
  ) {
    return {
      send,
      dispatcher: createPushWakeDispatcher({
        repository: repository(),
        provider: { send },
        tokenReader: { read: () => Promise.resolve("native-token") },
        clock,
        jitter: () => 0,
      }),
    };
  }

  it("atomically materializes duplicate recipient sequences once under concurrent consumers", async () => {
    const id = await event(now, [recipient, recipient]);
    await Promise.all([
      repository().materialize(100),
      repository().materialize(100),
    ]);
    await repository().materialize(100);
    const rows = await context.db
      .selectFrom("push_wakeups")
      .selectAll()
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_id: id,
      recipient_device_id: recipient,
      recipient_user_id: recipientUser,
      expires_at: new Date(now.getTime() + 3_600_000),
    });
    expect(
      (
        await context.db
          .selectFrom("outbox_events")
          .selectAll()
          .executeTakeFirstOrThrow()
      ).published_at,
    ).toEqual(now);
  });

  it("bounds SQL round trips for a full 100-event, nine-recipient materialization batch", async () => {
    const devices = [recipient];
    for (let index = 0; index < 8; index++) {
      const user = await fixtures.user();
      const device = await fixtures.device(user.id);
      await fixtures.member(tripId, user.id, device.id);
      devices.push(device.id);
    }
    const ids = await events(100, devices);
    let commands = 0;
    const counted = context.db.withPlugin({
      transformQuery({ node }) {
        commands++;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    await createKyselyPushWakeRepository(counted, clock).materialize(100);
    const wakes = await context.db
      .selectFrom("push_wakeups")
      .select(["event_id", "recipient_device_id"])
      .execute();
    expect(wakes).toHaveLength(900);
    expect(
      new Set(wakes.map((row) => `${row.event_id}:${row.recipient_device_id}`))
        .size,
    ).toBe(900);
    expect(new Set(wakes.map((row) => row.event_id))).toEqual(new Set(ids));
    expect(
      await context.db
        .selectFrom("outbox_events")
        .select("id")
        .where("published_at", "is", null)
        .execute(),
    ).toEqual([]);
    // BEGIN/COMMIT are driver operations; this counts actual application SQL.
    expect(commands).toBeLessThanOrEqual(8);
    process.stdout.write(
      `${JSON.stringify({
        measurement: "push_materialize_application_sql",
        events: 100,
        recipientsPerEvent: 9,
        wakes: wakes.length,
        commands,
      })}\n`,
    );
  });

  it("does not retain a trip foreign-key lock across per-event network round trips", async () => {
    await events(20);
    let entered!: () => void;
    const inserted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let hasInserted = false;
    let stopDelays = false;
    const insertQueries = new WeakSet<object>();
    const plugin: KyselyPlugin = {
      transformQuery({ node, queryId }) {
        if (
          node.kind === "InsertQueryNode" &&
          node.into?.table.identifier.name === "push_wakeups"
        )
          insertQueries.add(queryId);
        return node;
      },
      async transformResult({ result, queryId }) {
        if (insertQueries.has(queryId)) {
          insertQueries.delete(queryId);
          hasInserted = true;
          entered();
        }
        // Simulate a modest 30ms edge/database round trip, only after a real
        // INSERT has acquired PostgreSQL's trip foreign-key KEY SHARE lock.
        if (hasInserted && !stopDelays)
          await new Promise((resolve) => setTimeout(resolve, 30));
        return result;
      },
    };
    const materializing = createKyselyPushWakeRepository(
      context.db.withPlugin(plugin),
      clock,
    ).materialize(100);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        inserted,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Materializer did not reach a real insert")),
            5_000,
          );
        }),
      ]);
      // This deliberately uses the strongest trip mutation lock. Batching
      // must bound the maintenance transaction even for physical deletion.
      await context.db.transaction().execute(async (tx) => {
        await sql`set local lock_timeout = '500ms'`.execute(tx);
        await tx
          .selectFrom("trips")
          .select("id")
          .where("id", "=", tripId)
          .forUpdate()
          .executeTakeFirstOrThrow();
      });
      await materializing;
      expect(
        await context.db.selectFrom("push_wakeups").select("id").execute(),
      ).toHaveLength(20);
    } finally {
      clearTimeout(timer);
      stopDelays = true;
      await materializing;
    }
  });

  it("preserves per-event validation, expiry and trip scoping inside a mixed batch", async () => {
    const valid = await event();
    const expired = await event(new Date(now.getTime() - 3_600_000));
    const malformed = await event();
    const oversizedSequence = await event();
    const foreign = await event();
    const missing = await event();
    const empty = await event(now, []);
    const otherTrip = await fixtures.trip(owner.userId);
    const original = await context.db
      .selectFrom("outbox_events")
      .select("payload")
      .where("id", "=", foreign)
      .executeTakeFirstOrThrow();
    await context.db
      .updateTable("outbox_events")
      .set({ payload: { tripId, recipientSequences: ["not-a-sequence"] } })
      .where("id", "=", malformed)
      .execute();
    await context.db
      .updateTable("outbox_events")
      .set({
        payload: { tripId, recipientSequences: ["9999999999999999999"] },
      })
      .where("id", "=", oversizedSequence)
      .execute();
    await context.db
      .updateTable("outbox_events")
      .set({ payload: { ...original.payload, tripId: otherTrip.id } })
      .where("id", "=", foreign)
      .execute();
    await context.db
      .updateTable("outbox_events")
      .set({
        payload: {
          tripId: crypto.randomUUID(),
          recipientSequences: original.payload.recipientSequences,
        },
      })
      .where("id", "=", missing)
      .execute();
    await repository().materialize(100);
    const outcomes = await context.db
      .selectFrom("outbox_events")
      .select(["id", "published_at", "last_error"])
      .execute();
    for (const row of outcomes) expect(row.published_at).toEqual(now);
    expect(new Map(outcomes.map((row) => [row.id, row.last_error]))).toEqual(
      new Map([
        [valid, null],
        [expired, "OUTBOX_EXPIRED"],
        [malformed, "OUTBOX_INVALID_PAYLOAD"],
        [oversizedSequence, "OUTBOX_INVALID_PAYLOAD"],
        [foreign, null],
        [missing, "OUTBOX_EXPIRED"],
        [empty, null],
      ]),
    );
    expect(
      await context.db
        .selectFrom("push_wakeups")
        .select(["event_id", "recipient_device_id", "trip_id", "expires_at"])
        .execute(),
    ).toEqual([
      {
        event_id: valid,
        recipient_device_id: recipient,
        trip_id: tripId,
        expires_at: new Date(now.getTime() + 3_600_000),
      },
    ]);
  });

  it("rolls back real fanout and publication together after a publication failure", async () => {
    const ids = await events(20);
    const publications = new WeakSet<object>();
    const broken = context.db.withPlugin({
      transformQuery({ node, queryId }) {
        if (
          node.kind === "UpdateQueryNode" &&
          node.table &&
          TableNode.is(node.table) &&
          node.table.table.identifier.name === "outbox_events"
        )
          publications.add(queryId);
        return node;
      },
      async transformResult({ result, queryId }) {
        if (publications.has(queryId))
          throw new Error("Injected failure after real publication SQL");
        return result;
      },
    });
    await expect(
      createKyselyPushWakeRepository(broken, clock).materialize(100),
    ).rejects.toThrow("Injected failure after real publication SQL");
    expect(
      await context.db.selectFrom("push_wakeups").select("id").execute(),
    ).toEqual([]);
    expect(
      await context.db
        .selectFrom("outbox_events")
        .select("id")
        .where("published_at", "is", null)
        .execute(),
    ).toHaveLength(20);
    await repository().materialize(100);
    const wakes = await context.db
      .selectFrom("push_wakeups")
      .select("event_id")
      .execute();
    expect(wakes).toHaveLength(20);
    expect(new Set(wakes.map((wake) => wake.event_id))).toEqual(new Set(ids));
  });

  it("materializes bounded, disjoint event batches concurrently without lost or duplicate wakes", async () => {
    const ids = await events(100);
    await Promise.all(
      Array.from({ length: 4 }, () => repository().materialize(25)),
    );
    await repository().materialize(100);
    const wakes = await context.db
      .selectFrom("push_wakeups")
      .select("event_id")
      .execute();
    expect(wakes).toHaveLength(100);
    expect(new Set(wakes.map((wake) => wake.event_id))).toEqual(new Set(ids));
    expect(
      await context.db
        .selectFrom("outbox_events")
        .select("id")
        .where("published_at", "is", null)
        .execute(),
    ).toEqual([]);
  });

  it("defers a wake rather than deadlocking with actual physical account erasure", async () => {
    await event();
    const account = (db = context.db) =>
      createKyselyAccountService(
        db,
        { delete: async () => {} },
        clock,
        async () => {},
      );
    const subject = await context.db
      .selectFrom("users")
      .select("clerk_subject")
      .where("id", "=", recipientUser)
      .executeTakeFirstOrThrow();
    const deletion = await account().requestDeletion(subject.clerk_subject);
    function gate(table: "outbox_events" | "users") {
      let entered!: () => void;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let armed = true;
      const ids = new WeakSet<object>();
      const plugin: KyselyPlugin = {
        transformQuery({ node, queryId }) {
          if (
            armed &&
            node.kind === "SelectQueryNode" &&
            node.from?.froms.some(
              (from) =>
                TableNode.is(from) && from.table.identifier.name === table,
            ) &&
            node.endModifiers?.some((m) => m.modifier === "ForUpdate")
          ) {
            armed = false;
            ids.add(queryId);
          }
          return node;
        },
        async transformResult({ result, queryId }) {
          if (ids.has(queryId)) {
            ids.delete(queryId);
            entered();
            await released;
          }
          return result;
        },
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        plugin,
        async entered() {
          try {
            await Promise.race([
              held,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error(`Real ${table} row lock not reached`)),
                  5_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        },
        release,
      };
    }
    const outboxHeld = gate("outbox_events");
    const userHeld = gate("users");
    let materializerSettled = false;
    const materializing = createKyselyPushWakeRepository(
      context.db.withPlugin(outboxHeld.plugin),
      clock,
    ).materialize(100);
    const observedMaterializer = materializing.then(
      () => {
        materializerSettled = true;
        return "fulfilled";
      },
      (error: unknown) => {
        materializerSettled = true;
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        return `rejected:${typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown"}`;
      },
    );
    let cleaning: Promise<void> | undefined;
    let observedCleanup: Promise<string> | undefined;
    try {
      await outboxHeld.entered();
      cleaning = account(context.db.withPlugin(userHeld.plugin)).cleanup();
      observedCleanup = cleaning.then(
        () => "fulfilled",
        () => "rejected",
      );
      await userHeld.entered();
      outboxHeld.release();
      // With the old source, let the actual FK insertion wait for the locked
      // user before cleanup attempts the reverse outbox lock. A corrected
      // nonblocking preflight may finish/defer instead of entering that wait.
      const deadline = performance.now() + 2_000;
      let blocked = false;
      while (!materializerSettled && !blocked && performance.now() < deadline) {
        blocked = (
          await sql<{ blocked: boolean }>`select exists(
            select 1 from pg_stat_activity where datname=current_database()
              and wait_event_type='Lock'
              and query like 'insert into "push_wakeups"%'
          ) as blocked`.execute(context.db)
        ).rows[0]!.blocked;
        if (!materializerSettled && !blocked)
          await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(materializerSettled || blocked).toBe(true);
      userHeld.release();
      expect(await observedMaterializer).toBe("fulfilled");
      expect(await observedCleanup).toBe("fulfilled");
      expect((await account().deletionStatus(deletion.requestId)).status).toBe(
        "COMPLETE",
      );
      expect(
        await context.db
          .selectFrom("users")
          .select("id")
          .where("id", "=", recipientUser)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await context.db.selectFrom("outbox_events").select("id").execute(),
      ).toEqual([]);
      expect(
        await context.db.selectFrom("push_wakeups").select("id").execute(),
      ).toEqual([]);
    } finally {
      outboxHeld.release();
      userHeld.release();
      await observedMaterializer;
      await observedCleanup;
    }
  });

  it.each(["users", "devices", "trips"] as const)(
    "defers whole events with a busy %s parent while cold work beyond the first 100 progresses",
    async (table) => {
      const hotExpiresAt = new Date(now.getTime() + 3_599_000);
      const hotIds = await events(105, [recipient, owner.deviceId]);
      await context.db
        .updateTable("outbox_events")
        .set({
          available_at: new Date(now.getTime() - 1_000),
          created_at: new Date(now.getTime() - 1_000),
        })
        .where("id", "in", hotIds)
        .execute();
      const coldTrip = await fixtures.trip(owner.userId);
      await fixtures.member(coldTrip.id, owner.userId, owner.deviceId, {
        role: "OWNER",
      });
      const coldInbox = await context.db
        .insertInto("inbox_events")
        .values({
          recipient_device_id: owner.deviceId,
          trip_id: coldTrip.id,
          event_type: "TRIP_CHANGED",
          aggregate_id: coldTrip.id,
          available_at: now,
          created_at: now,
          payload: { status: "LOBBY" },
        })
        .returning("sequence")
        .executeTakeFirstOrThrow();
      const coldId = crypto.randomUUID();
      await context.db
        .insertInto("outbox_events")
        .values({
          id: coldId,
          event_type: "trip.changed",
          aggregate_id: coldTrip.id,
          dedupe_key: `test:${coldId}`,
          payload: {
            tripId: coldTrip.id,
            recipientSequences: [coldInbox.sequence],
          },
          available_at: now,
          created_at: now,
          published_at: null,
          last_error: null,
        })
        .execute();
      let entered!: () => void;
      let release!: () => void;
      const locked = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const key =
        table === "users"
          ? recipientUser
          : table === "devices"
            ? recipient
            : tripId;
      const holder = context.db.transaction().execute(async (tx) => {
        await tx
          .selectFrom(table)
          .select("id")
          .where("id", "=", key)
          .forUpdate()
          .executeTakeFirstOrThrow();
        entered();
        await released;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          locked,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Parent lock not reached")),
              5_000,
            );
          }),
        ]);
        await repository().materialize(100);
        expect(
          await context.db.selectFrom("push_wakeups").select("id").execute(),
        ).toEqual([]);
        await repository().materialize(100);
        expect(
          await context.db
            .selectFrom("push_wakeups")
            .select("event_id")
            .execute(),
        ).toEqual([{ event_id: coldId }]);
        const hot = await context.db
          .selectFrom("outbox_events")
          .select(["published_at", "available_at"])
          .where("id", "in", hotIds)
          .execute();
        expect(hot).toHaveLength(105);
        for (const row of hot) {
          expect(row.published_at).toBeNull();
          expect(row.available_at).toEqual(new Date(now.getTime() + 60_000));
        }
        expect(
          (
            await context.db
              .selectFrom("outbox_events")
              .select("published_at")
              .where("id", "=", coldId)
              .executeTakeFirstOrThrow()
          ).published_at,
        ).toEqual(now);
      } finally {
        clearTimeout(timer);
        release();
        await holder;
      }
      now = new Date(now.getTime() + 60_000);
      await repository().materialize(100);
      await repository().materialize(100);
      await repository().materialize(100);
      const wakes = await context.db
        .selectFrom("push_wakeups")
        .select(["event_id", "recipient_device_id", "expires_at"])
        .execute();
      expect(wakes).toHaveLength(211);
      expect(
        new Set(
          wakes.map((row) => `${row.event_id}:${row.recipient_device_id}`),
        ).size,
      ).toBe(211);
      for (const id of hotIds) {
        const recipients = wakes.filter((row) => row.event_id === id);
        expect(recipients).toHaveLength(2);
        for (const row of recipients)
          expect(row.expires_at).toEqual(hotExpiresAt);
      }
      expect(
        await context.db
          .selectFrom("outbox_events")
          .select("id")
          .where("published_at", "is", null)
          .execute(),
      ).toEqual([]);
    },
  );

  it("leases once concurrently and fences stale completion and token invalidation after a crash/reclaim", async () => {
    await event();
    await repository().materialize(100);
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () => repository().claim()),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const first = attempts.find((value) => value !== null)!;
    now = new Date(now.getTime() + 120_001);
    const next = await claimed();
    expect(next.id).toBe(first.id);
    expect(next.hint.eventId).toBe(first.hint.eventId);
    expect(next.leaseToken).not.toBe(first.leaseToken);
    await repository().complete(first, "SENT");
    await repository().invalidateToken(first, oldHash, {
      registeredAt: new Date("2026-08-29T08:00:00Z"),
      committed: "0",
    });
    expect(
      (
        await context.db
          .selectFrom("push_wakeups")
          .selectAll()
          .executeTakeFirstOrThrow()
      ).completed_at,
    ).toBeNull();
    expect(
      (
        await context.db
          .selectFrom("devices")
          .select("push_token_hash")
          .where("id", "=", recipient)
          .executeTakeFirstOrThrow()
      ).push_token_hash,
    ).toEqual(oldHash);
    await repository().complete(next, "SENT");
    expect(
      (
        await context.db
          .selectFrom("push_wakeups")
          .selectAll()
          .executeTakeFirstOrThrow()
      ).outcome,
    ).toBe("SENT");
  });

  it("rechecks suspension, revocation, credential expiry, membership device and bound account", async () => {
    await event();
    await repository().materialize(100);
    const job = await claimed();
    expect(await repository().target(job)).not.toBeNull();
    await context.db
      .updateTable("users")
      .set({ suspended_at: now })
      .where("id", "=", recipientUser)
      .execute();
    expect(await repository().target(job)).toBeNull();
    await context.db
      .updateTable("users")
      .set({ suspended_at: null })
      .where("id", "=", recipientUser)
      .execute();
    await context.db
      .updateTable("devices")
      .set({ revoked_at: now })
      .where("id", "=", recipient)
      .execute();
    expect(await repository().target(job)).toBeNull();
    await context.db
      .updateTable("devices")
      .set({ revoked_at: null, background_credential_expires_at: now })
      .where("id", "=", recipient)
      .execute();
    expect(await repository().target(job)).toBeNull();
    await context.db
      .updateTable("devices")
      .set({
        background_credential_expires_at: new Date(now.getTime() + 86_400_000),
      })
      .where("id", "=", recipient)
      .execute();
    expect(
      await repository().target({ ...job, userId: owner.userId }),
    ).toBeNull();
    const replacement = await createIdentityTripFixtures(context.db).device(
      recipientUser,
      {
        id: crypto.randomUUID(),
        installation_id: "replacement",
        authentication_public_key: new Uint8Array(
          (
            await context.db
              .selectFrom("devices")
              .select("authentication_public_key")
              .where("id", "=", recipient)
              .executeTakeFirstOrThrow()
          ).authentication_public_key,
        ),
        e2ee_public_key: Buffer.alloc(32, 99),
      },
    );
    await context.db
      .updateTable("trip_members")
      .set({ participating_device_id: replacement.id })
      .where("user_id", "=", recipientUser)
      .execute();
    expect(await repository().target(job)).toBeNull();
  });

  it("preserves a rotated token if an old provider response reports invalid registration", async () => {
    await event();
    const send = vi
      .fn<() => Promise<PushSendResult>>()
      .mockImplementation(async () => {
        await context.db
          .updateTable("devices")
          .set({
            push_token_hash: newHash,
            encrypted_push_token: Buffer.from("new-frame"),
          })
          .where("id", "=", recipient)
          .execute();
        return { kind: "invalid-token" };
      });
    await dispatcher(send).dispatcher.run(1);
    expect(
      (
        await context.db
          .selectFrom("devices")
          .select("push_token_hash")
          .where("id", "=", recipient)
          .executeTakeFirstOrThrow()
      ).push_token_hash,
    ).toEqual(newHash);
    expect(
      (
        await context.db
          .selectFrom("push_wakeups")
          .select("outcome")
          .executeTakeFirstOrThrow()
      ).outcome,
    ).toBe("INVALID_TOKEN");
  });

  it("clears an explicitly rejected unchanged registration without creating a photo receipt", async () => {
    await event();
    await dispatcher(
      vi
        .fn<() => Promise<PushSendResult>>()
        .mockResolvedValue({ kind: "invalid-token" }),
    ).dispatcher.run(1);
    expect(
      await context.db
        .selectFrom("devices")
        .select(["push_token_hash", "encrypted_push_token"])
        .where("id", "=", recipient)
        .executeTakeFirstOrThrow(),
    ).toEqual({ push_token_hash: null, encrypted_push_token: null });
    expect(
      await context.db.selectFrom("receipts").selectAll().execute(),
    ).toEqual([]);
  });

  it("preserves a freshly re-registered identical APNs token after an older unregistration response", async () => {
    await event();
    await repository().materialize(100);
    const job = await claimed();
    const revision = (await repository().target(job))!.revision;
    now = new Date(now.getTime() + 1_000);
    await context.db
      .updateTable("devices")
      .set({ updated_at: now })
      .where("id", "=", recipient)
      .execute();
    await repository().invalidateToken(
      job,
      oldHash,
      revision,
      new Date(now.getTime() - 500),
    );
    expect(
      (
        await context.db
          .selectFrom("devices")
          .select("push_token_hash")
          .where("id", "=", recipient)
          .executeTakeFirstOrThrow()
      ).push_token_hash,
    ).toEqual(oldHash);
  });

  it("fences stale invalidation after an identical token PATCH in the same clock second", async () => {
    await event();
    await repository().materialize(100);
    const job = await claimed();
    const revision = (await repository().target(job))!.revision;
    await context.db
      .updateTable("devices")
      .set({
        push_token_request_revision: "1",
        push_token_committed_revision: "1",
      })
      .where("id", "=", recipient)
      .execute();
    await repository().invalidateToken(job, oldHash, revision);
    const stored = await context.db
      .selectFrom("devices")
      .select("push_token_hash")
      .where("id", "=", recipient)
      .executeTakeFirstOrThrow();
    expect(stored.push_token_hash).toEqual(oldHash);
  });

  it("never lets a near-expiry exhausted wake absorb a fresh commit when send fails", async () => {
    const old = await event(new Date(now.getTime() - 3_590_000));
    await repository().materialize(100);
    await context.db
      .updateTable("push_wakeups")
      .set({ attempt_count: 7 })
      .execute();
    const fresh = await event();
    await repository().materialize(100);
    const send = vi
      .fn<() => Promise<PushSendResult>>()
      .mockResolvedValue({ kind: "retry", code: "PROVIDER_UNAVAILABLE" });
    await dispatcher(send).dispatcher.run(1);
    const rows = await context.db
      .selectFrom("push_wakeups")
      .selectAll()
      .execute();
    expect(rows.find((row) => row.event_id === old)?.outcome).toBe(
      "DEAD_LETTERED",
    );
    expect(rows.find((row) => row.event_id === fresh)).toMatchObject({
      completed_at: null,
      attempt_count: 0,
      expires_at: new Date(now.getTime() + 3_600_000),
    });
    send.mockResolvedValue({ kind: "accepted" });
    await dispatcher(send).dispatcher.run(1);
    expect(
      (
        await context.db
          .selectFrom("push_wakeups")
          .selectAll()
          .where("event_id", "=", fresh)
          .executeTakeFirstOrThrow()
      ).outcome,
    ).toBe("SENT");
  });

  it("does not coalesce newer work, and preserves a60second follow-up window after acceptance", async () => {
    const first = await event();
    await repository().materialize(100);
    const job = await claimed();
    now = new Date(now.getTime() + 1_000);
    const second = await event();
    await repository().materialize(100);
    await repository().complete(job, "SENT");
    expect(
      (
        await context.db
          .selectFrom("push_wakeups")
          .selectAll()
          .where("event_id", "=", second)
          .executeTakeFirstOrThrow()
      ).completed_at,
    ).toBeNull();
    expect(await repository().claim()).toBeNull();
    now = new Date(now.getTime() + 60_000);
    const followup = await claimed();
    expect(followup.hint.eventId).toBe(second);
    expect(followup.hint.eventId).not.toBe(first);
  });

  it("bounds accepted-work coalescing rather than issuing an unbounded history update", async () => {
    await event();
    await repository().materialize(100);
    const first = await claimed();
    const parents = Array.from({ length: 105 }, () => ({
      id: crypto.randomUUID(),
      event_type: "trip.changed",
      aggregate_id: tripId,
      dedupe_key: crypto.randomUUID(),
      payload: { tripId, recipientSequences: [] },
      available_at: now,
      created_at: now,
      published_at: now,
      last_error: null,
    }));
    await context.db.insertInto("outbox_events").values(parents).execute();
    await context.db
      .insertInto("push_wakeups")
      .values(
        parents.map((parent) => ({
          id: crypto.randomUUID(),
          event_id: parent.id,
          trip_id: tripId,
          recipient_device_id: recipient,
          recipient_user_id: recipientUser,
          created_at: now,
          available_at: now,
          expires_at: first.expiresAt,
          completed_at: null,
          outcome: null,
          lease_token: null,
          last_error: null,
        })),
      )
      .execute();
    await repository().complete(first, "SENT");
    const rows = await context.db
      .selectFrom("push_wakeups")
      .select("outcome")
      .execute();
    expect(rows.filter((row) => row.outcome === "COALESCED")).toHaveLength(100);
    expect(rows.filter((row) => row.outcome === null)).toHaveLength(5);
  });

  it("expires stale work without send and compacts only aged completed parents", async () => {
    await event();
    await repository().materialize(100);
    now = new Date(now.getTime() + 3_600_000);
    await repository().compact(200);
    expect(
      (
        await context.db
          .selectFrom("push_wakeups")
          .select("outcome")
          .executeTakeFirstOrThrow()
      ).outcome,
    ).toBe("EXPIRED");
    expect(await repository().claim()).toBeNull();
    now = new Date(now.getTime() + 7 * 86_400_000);
    await repository().compact(200);
    expect(
      await context.db.selectFrom("outbox_events").selectAll().execute(),
    ).toEqual([]);
    expect(
      await context.db.selectFrom("push_wakeups").selectAll().execute(),
    ).toEqual([]);
  });

  it("does not route a forged sequence from a different trip", async () => {
    const id = await event();
    const fixtures = createIdentityTripFixtures(context.db);
    const otherTrip = await fixtures.trip(owner.userId, {
      id: crypto.randomUUID(),
    });
    await context.db
      .updateTable("outbox_events")
      .set({
        payload: {
          tripId: otherTrip.id,
          recipientSequences: [
            (
              await context.db
                .selectFrom("inbox_events")
                .select("sequence")
                .executeTakeFirstOrThrow()
            ).sequence,
          ],
        },
      })
      .where("id", "=", id)
      .execute();
    await repository().materialize(100);
    expect(
      await context.db.selectFrom("push_wakeups").selectAll().execute(),
    ).toEqual([]);
  });

  it("writes lifecycle hints atomically and rolls them back with failed state changes", async () => {
    const lifecycle = createKyselyTripLifecycle(context.db, clock);
    await expect(
      lifecycle.change(owner, tripId, { action: "END", expectedVersion: 999 }),
    ).rejects.toMatchObject({ kind: "VERSION_CONFLICT" });
    expect(
      await context.db.selectFrom("outbox_events").selectAll().execute(),
    ).toEqual([]);
    await lifecycle.change(owner, tripId, {
      action: "END",
      expectedVersion: 1,
    });
    const events = await context.db
      .selectFrom("outbox_events")
      .selectAll()
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("trip.lifecycle");
    await repository().materialize(100);
    expect(
      await context.db
        .selectFrom("push_wakeups")
        .select("recipient_device_id")
        .execute(),
    ).toHaveLength(2);
  });
});
