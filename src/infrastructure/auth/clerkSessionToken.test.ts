import { CrewRollApiProblem } from "../../application/problems/crewRollApiProblem";

import { ClerkSessionTokenSource } from "./clerkSessionToken";

describe("ClerkSessionTokenSource", () => {
  it("requests the ordinary Clerk session token with no options", async () => {
    const getToken = jest.fn<Promise<string | null>, []>();
    getToken.mockResolvedValue("real-session-token");

    await expect(
      new ClerkSessionTokenSource(getToken).getToken(),
    ).resolves.toBe("real-session-token");
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledWith();
  });

  it.each([null, "", "   \n\t"])(
    "fails closed when Clerk returns an unusable token: %p",
    async (token) => {
      const getToken = jest.fn<Promise<string | null>, []>();
      getToken.mockResolvedValue(token);

      await expect(
        new ClerkSessionTokenSource(getToken).getToken(),
      ).rejects.toEqual(new CrewRollApiProblem("AUTH_REQUIRED"));
    },
  );

  it("does not expose provider errors or attach them as a cause", async () => {
    const providerError = new Error("provider secret detail");
    const getToken = jest.fn<Promise<string | null>, []>();
    getToken.mockRejectedValue(providerError);

    let rejection: unknown;
    try {
      await new ClerkSessionTokenSource(getToken).getToken();
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toEqual(new CrewRollApiProblem("AUTH_REQUIRED"));
    expect(rejection).not.toBe(providerError);
    expect(rejection).not.toHaveProperty("cause");
    expect(String(rejection)).not.toContain("provider secret detail");
  });
});
