import { createRejectMember } from "./RejectMember";
import { CrewRollApiProblem } from "../problems/crewRollApiProblem";

const deviceId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3120";
const tripId = "0191a203-227b-7011-9213-141516171819";
const membershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150";
function fixture() {
  const api = { rejectMember: jest.fn(async (): Promise<void> => undefined) };
  const random = { getBytes: jest.fn(async () => new Uint8Array(16)) };
  return {
    api,
    random,
    service: createRejectMember({ api, random, deviceId }),
  };
}

it("returns only the rejected membership receipt after the adapter's confirmed 204", async () => {
  const { api, random, service } = fixture();
  const receipt = await service.reject(tripId, membershipId);
  expect(api.rejectMember).toHaveBeenCalledWith(
    deviceId,
    expect.any(String),
    tripId,
    membershipId,
  );
  expect(random.getBytes).toHaveBeenCalledWith(16);
  expect(receipt).toEqual({ tripId, membershipId, status: "REJECTED" });
  expect(Object.keys(receipt).sort()).toEqual([
    "membershipId",
    "status",
    "tripId",
  ]);
  expect(Object.isFrozen(receipt)).toBe(true);
});

it.each([new Error("reply unavailable"), new CrewRollApiProblem("CONFLICT")])(
  "does not infer rejection when the POST/DELETE outcome is unconfirmed: %s",
  async (failure) => {
    const { api, service } = fixture();
    api.rejectMember.mockRejectedValueOnce(failure);
    await expect(service.reject(tripId, membershipId)).rejects.toBe(failure);
    expect(api.rejectMember).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["not-a-trip", membershipId],
  [tripId, "not-a-member"],
])("rejects invalid context before dispatch (%s, %s)", async (trip, member) => {
  const { api, random, service } = fixture();
  await expect(service.reject(trip, member)).rejects.toEqual(
    new CrewRollApiProblem("INVALID_REQUEST"),
  );
  expect(api.rejectMember).not.toHaveBeenCalled();
  expect(random.getBytes).not.toHaveBeenCalled();
});
