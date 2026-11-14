import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createKyselyPushWakeRepository } from "../../services/control-plane/src/db/push/kyselyPushWakeRepository.js";
import { createPushWakeDispatcher } from "../../services/control-plane/src/modules/push/dispatchPushWakeups.js";
import { createKyselyTripLifecycle } from "../../services/control-plane/src/db/trips/kyselyTripLifecycle.js";
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
    const fixtures = createIdentityTripFixtures(context.db);
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
