import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createKyselyAccountService } from "../../services/control-plane/src/db/account/kyselyAccountService.js";
import { requireUnblockedTrip } from "../../services/control-plane/src/db/account/blockPolicy.js";
import { createKyselyIdentityUnitOfWork } from "../../services/control-plane/src/db/identity/kyselyIdentityUnitOfWork.js";
import {
  createMediaCoordinationFixtures,
  FIXED_NOW,
} from "./support/mediaFixtures.js";
import {
  startMigratedPostgres,
  truncateIdentityTripTables,
  type PostgresTestContext,
} from "./support/postgres.js";

describe.sequential("account privacy and safety", () => {
  let context: PostgresTestContext;
  let fixtures: ReturnType<typeof createMediaCoordinationFixtures>;
  let now: Date;
  const removeObject = vi.fn(async (_key: string) => {});
  const removeIdentity = vi.fn(async (_subject: string) => {});
  const service = (terms = false) =>
    createKyselyAccountService(
      context.db,
      { delete: removeObject },
      { now: () => now },
      removeIdentity,
      terms,
    );
  beforeAll(async () => {
    context = await startMigratedPostgres();
  });
  afterAll(async () => {
    await context?.stop();
  });
  beforeEach(async () => {
    await truncateIdentityTripTables(context.db);
    fixtures = createMediaCoordinationFixtures(context.db);
    now = new Date(FIXED_NOW.getTime() + 60_000);
    removeObject.mockReset().mockResolvedValue(undefined);
    removeIdentity.mockReset().mockResolvedValue(undefined);
  });
  const subject = async (id: string) =>
    (
      await context.db
        .selectFrom("users")
        .select("clerk_subject")
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).clerk_subject;

  it("deletes an account that has never opened the app and fences a later first profile sync", async () => {
    const clerkSubject = "user_web_only";
    const receipt = await service().requestDeletion(clerkSubject);
    await service().cleanup();
    expect((await service().deletionStatus(receipt.requestId)).status).toBe(
      "COMPLETE",
    );
    await expect(
      createKyselyIdentityUnitOfWork(context.db).synchronizeProfile(
        clerkSubject,
        "Late profile",
        fixtures.uuid(),
        now,
      ),
    ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
    expect(
      await context.db.selectFrom("users").selectAll().execute(),
    ).toHaveLength(0);
  });

  it("erases a host graph and ciphertext without deleting other accounts or recreating the deleted identity", async () => {
    const parents = await fixtures.parents();
    const clerkSubject = await subject(parents.sourceUserId);
    const upload = await fixtures.uploadSession(parents);
    const uploadObject = await fixtures.uploadObject(upload.id);
    const asset = await fixtures.asset(parents);
    const assetObject = await fixtures.assetObject(asset.id);
    const delivery = await fixtures.delivery(asset.id, parents);
    await fixtures.receipt(delivery.id);
    await fixtures.inboxEvent(parents);
    await fixtures.auditEvent(parents);
    await fixtures.apiIdempotency(parents.sourceUserId);
    const receipt = await service().requestDeletion(clerkSubject);
    expect(await service().requestDeletion(clerkSubject)).toEqual(receipt);
    expect(receipt.status).toBe("PENDING");
    await expect(service().policy(clerkSubject)).rejects.toMatchObject({
      kind: "AUTH_INVALID",
    });
    expect(
      (
        await context.db
          .selectFrom("devices")
          .select("revoked_at")
          .where("id", "=", parents.sourceDeviceId)
          .executeTakeFirstOrThrow()
      ).revoked_at,
    ).not.toBeNull();
    await service().cleanup();
    expect(await service().deletionStatus(receipt.requestId)).toEqual({
      ...receipt,
      status: "COMPLETE",
    });
    expect(removeIdentity).toHaveBeenCalledWith(
      clerkSubject,
      expect.objectContaining({ appleGrant: null, appleRevoked: false }),
    );
    expect(removeObject.mock.calls.flat().sort()).toEqual(
      [uploadObject.s3_key, assetObject.s3_key].sort(),
    );
    expect(
      await context.db
        .selectFrom("users")
        .select("id")
        .where("id", "=", parents.sourceUserId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await context.db
        .selectFrom("trips")
        .select("id")
        .where("id", "=", parents.tripId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await context.db.selectFrom("users").select("id").execute(),
    ).toHaveLength(2);
    await expect(
      createKyselyIdentityUnitOfWork(context.db).synchronizeProfile(
        clerkSubject,
        "Should not return",
        fixtures.uuid(),
        now,
      ),
    ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
  });

  it("retires ciphertext through repeated provider failure without erasing unfinished account records", async () => {
    const parents = await fixtures.parents();
    const asset = await fixtures.asset(parents);
    await fixtures.assetObject(asset.id);
    const receipt = await service().requestDeletion(
      await subject(parents.sourceUserId),
    );
    removeIdentity.mockRejectedValueOnce(new Error("provider offline"));
    removeIdentity.mockRejectedValueOnce(new Error("provider still offline"));
    await expect(service().cleanup()).rejects.toThrow("needs retry");
    expect(removeObject).toHaveBeenCalledTimes(1);
    const objects = await context.db
      .selectFrom("account_deletion_objects")
      .selectAll()
      .where("request_id", "=", receipt.requestId)
      .execute();
    expect(objects).toHaveLength(1);
    expect(objects[0]?.deleted_at).toEqual(now);
    expect(
      await context.db
        .selectFrom("assets")
        .select("id")
        .where("id", "=", asset.id)
        .executeTakeFirst(),
    ).toBeDefined();
    expect(
      await context.db
        .selectFrom("users")
        .select("id")
        .where("id", "=", parents.sourceUserId)
        .executeTakeFirst(),
    ).toBeDefined();
    now = new Date(now.getTime() + 3600_000);
    await expect(service().cleanup()).rejects.toThrow("needs retry");
    expect(removeObject).toHaveBeenCalledTimes(1);
    expect((await service().deletionStatus(receipt.requestId)).status).toBe(
      "PENDING",
    );
    now = new Date(now.getTime() + 3600_000);
    await service().cleanup();
    expect((await service().deletionStatus(receipt.requestId)).status).toBe(
      "COMPLETE",
    );
    const job = await context.db
      .selectFrom("account_deletions")
      .selectAll()
      .where("id", "=", receipt.requestId)
      .executeTakeFirstOrThrow();
    expect(job.clerk_subject).toBeNull();
    expect(job.user_id).toBeNull();
    expect(removeIdentity).toHaveBeenCalledTimes(3);
    expect(removeObject).toHaveBeenCalledTimes(1);
  });

  it("confirms provider deletion independently but preserves records until storage retirement succeeds", async () => {
    const parents = await fixtures.parents();
    const asset = await fixtures.asset(parents);
    const object = await fixtures.assetObject(asset.id);
    const receipt = await service().requestDeletion(
      await subject(parents.sourceUserId),
    );
    removeObject.mockRejectedValueOnce(new Error("storage offline"));
    await expect(service().cleanup()).rejects.toThrow("needs retry");
    const pending = await context.db
      .selectFrom("account_deletions")
      .selectAll()
      .where("id", "=", receipt.requestId)
      .executeTakeFirstOrThrow();
    expect(pending.provider_deleted_at).toEqual(now);
    expect(pending.completed_at).toBeNull();
    expect((await service().deletionStatus(receipt.requestId)).status).toBe(
      "PENDING",
    );
    expect(
      await context.db
        .selectFrom("assets")
        .select("id")
        .where("id", "=", asset.id)
        .executeTakeFirst(),
    ).toBeDefined();
    expect(
      await context.db
        .selectFrom("users")
        .select("id")
        .where("id", "=", parents.sourceUserId)
        .executeTakeFirst(),
    ).toBeDefined();
    expect(
      (
        await context.db
          .selectFrom("account_deletion_objects")
          .select("deleted_at")
          .where("request_id", "=", receipt.requestId)
          .where("object_key", "=", object.s3_key)
          .executeTakeFirstOrThrow()
      ).deleted_at,
    ).toBeNull();
    now = new Date(now.getTime() + 3600_000);
    await service().cleanup();
    expect((await service().deletionStatus(receipt.requestId)).status).toBe(
      "COMPLETE",
    );
    expect(removeIdentity).toHaveBeenCalledTimes(1);
    expect(removeObject).toHaveBeenCalledTimes(2);
    expect(
      await context.db
        .selectFrom("users")
        .select("id")
        .where("id", "=", parents.sourceUserId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it("erases a guest's sources and membership while preserving the host and unrelated photos", async () => {
    const parents = await fixtures.parents();
    const ownerAsset = await fixtures.asset(parents);
    await fixtures.assetObject(ownerAsset.id);
    await fixtures.delivery(ownerAsset.id, parents);
    const guestAsset = await fixtures.asset(parents, {
      source_device_id: parents.recipientDeviceId,
    });
    const guestObject = await fixtures.assetObject(guestAsset.id);
    const receipt = await service().requestDeletion(
      await subject(parents.recipientUserId),
    );
    await service().cleanup();
    expect((await service().deletionStatus(receipt.requestId)).status).toBe(
      "COMPLETE",
    );
    expect(removeObject.mock.calls.flat()).toEqual([guestObject.s3_key]);
    expect(
      await context.db.selectFrom("assets").select("id").execute(),
    ).toEqual([{ id: ownerAsset.id }]);
    expect(await context.db.selectFrom("trips").select("id").execute()).toEqual(
      [{ id: parents.tripId }],
    );
  });

  it("requires consent only when configured and bounds repeated account operations", async () => {
    const account = await fixtures.identity.user();
    expect((await service().policy(account.clerk_subject)).accepted).toBe(
      false,
    );
    await expect(
      service(true).guard(account.clerk_subject, "register"),
    ).rejects.toMatchObject({ kind: "CONFLICT" });
    expect((await service().acceptTerms(account.clerk_subject)).accepted).toBe(
      true,
    );
    await service(true).guard(account.clerk_subject, "register");
    for (let index = 0; index < 5; index++)
      await service().guard(account.clerk_subject, "create");
    await expect(
      service().guard(account.clerk_subject, "create"),
    ).rejects.toMatchObject({ kind: "RATE_LIMITED" });
  });

  it("rejects suspended accounts even while an earlier token is still valid", async () => {
    const account = await fixtures.identity.user();
    await context.db
      .updateTable("users")
      .set({ suspended_at: now })
      .where("id", "=", account.id)
      .execute();
    await expect(
      service().guard(account.clerk_subject, "read"),
    ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
    await expect(
      service().guard(account.clerk_subject, "create"),
    ).rejects.toMatchObject({ kind: "AUTH_INVALID" });
    await expect(service().policy(account.clerk_subject)).rejects.toMatchObject(
      { kind: "AUTH_INVALID" },
    );
  });

  it("authorizes reports, stops sharing on block and rejects blocked pairs in either direction", async () => {
    const parents = await fixtures.parents();
    await context.db
      .updateTable("trips")
      .set({ state: "ACTIVE", started_at: FIXED_NOW, member_count: 2 })
      .where("id", "=", parents.tripId)
      .execute();
    await fixtures.identity.activeTrip(parents.sourceUserId, parents.tripId);
    await fixtures.identity.activeTrip(parents.recipientUserId, parents.tripId);
    const photo = await fixtures.asset(parents);
    const queued = await fixtures.delivery(photo.id, parents);
    const membership = await context.db
      .selectFrom("trip_members")
      .select("id")
      .where("user_id", "=", parents.sourceUserId)
      .executeTakeFirstOrThrow();
    const reporter = await subject(parents.recipientUserId);
    const body = {
      tripId: parents.tripId,
      membershipId: membership.id,
      reason: "PRIVACY" as const,
      details: "Shared without permission",
    };
    await expect(
      service().report(await subject(parents.outsiderUserId), body),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect((await service().report(reporter, body)).reportId).toMatch(
      /^[a-f0-9-]{36}$/,
    );
    await service().block(reporter, {
      tripId: parents.tripId,
      membershipId: membership.id,
    });
    expect((await service().blockedMembers(reporter)).items).toHaveLength(1);
    expect(
      await context.db
        .selectFrom("trip_members")
        .select(["leaving_at", "left_at", "left_incomplete"])
        .where("trip_id", "=", parents.tripId)
        .where("user_id", "=", parents.recipientUserId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ leaving_at: now, left_at: now, left_incomplete: true });
    expect(
      await context.db
        .selectFrom("user_active_trips")
        .select("user_id")
        .execute(),
    ).toEqual([{ user_id: parents.sourceUserId }]);
    expect(
      await context.db
        .selectFrom("deliveries")
        .select(["state", "saved_at"])
        .where("id", "=", queued.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "EXPIRED", saved_at: null });
    expect(
      await context.db.selectFrom("receipts").selectAll().execute(),
    ).toEqual([]);
    expect(
      await context.db
        .selectFrom("trip_members")
        .select(["state", "left_at"])
        .where("id", "=", membership.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "ACTIVE", left_at: null });
    expect(
      await context.db.selectFrom("assets").select(["id", "state"]).execute(),
    ).toEqual([{ id: photo.id, state: "COMMITTED" }]);
    await expect(
      context.db
        .transaction()
        .execute((tx) =>
          requireUnblockedTrip(tx, parents.tripId, parents.recipientUserId),
        ),
    ).rejects.toMatchObject({ kind: "INVITE_INVALID" });
    const newTrip = await fixtures.identity.trip(parents.recipientUserId);
    await fixtures.identity.member(
      newTrip.id,
      parents.recipientUserId,
      parents.recipientDeviceId,
      { role: "OWNER" },
    );
    await expect(
      context.db
        .transaction()
        .execute((tx) =>
          requireUnblockedTrip(tx, newTrip.id, parents.sourceUserId),
        ),
    ).rejects.toMatchObject({ kind: "INVITE_INVALID" });
    await service().unblock(reporter, parents.sourceUserId);
    await context.db
      .transaction()
      .execute((tx) =>
        requireUnblockedTrip(tx, newTrip.id, parents.sourceUserId),
      );
  });
});
