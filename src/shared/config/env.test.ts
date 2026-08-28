import { readPublicEnv } from "./env";

const TEST_PUBLISHABLE_KEY = "pk_test_c3ludGhldGlj";
const LIVE_PUBLISHABLE_KEY = "pk_live_c3ludGhldGlj";

function expectInvalidVariable(
  source: Record<string, string | undefined>,
  variableName: string,
  rejectedValue?: string,
) {
  let thrown: unknown;

  try {
    readPublicEnv(source);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain(variableName);
  if (rejectedValue) {
    expect((thrown as Error).message).not.toContain(rejectedValue);
  }
}

describe("readPublicEnv", () => {
  it("accepts a synthetic Clerk test publishable key", () => {
    expect(
      readPublicEnv({
        EXPO_PUBLIC_API_URL: "https://api.crewroll.app",
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY,
      }),
    ).toEqual({
      apiUrl: "https://api.crewroll.app",
      clerkPublishableKey: TEST_PUBLISHABLE_KEY,
    });
  });

  it("accepts a synthetic Clerk live publishable key", () => {
    expect(
      readPublicEnv({
        EXPO_PUBLIC_API_URL: "https://api.crewroll.app",
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: LIVE_PUBLISHABLE_KEY,
      }),
    ).toEqual({
      apiUrl: "https://api.crewroll.app",
      clerkPublishableKey: LIVE_PUBLISHABLE_KEY,
    });
  });

  it("normalizes a root trailing slash to the API origin", () => {
    expect(
      readPublicEnv({
        EXPO_PUBLIC_API_URL: "https://api.crewroll.app/",
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY,
      }).apiUrl,
    ).toBe("https://api.crewroll.app");
  });

  it.each([
    ["EXPO_PUBLIC_API_URL", { EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY }],
    ["EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY", { EXPO_PUBLIC_API_URL: "https://api.crewroll.app" }],
  ])("rejects a missing %s", (variableName, source) => {
    expectInvalidVariable(source, variableName);
  });

  it.each([
    ["an HTTP origin", "http://api.crewroll.app"],
    ["a URL with credentials", "https://crew:secret@api.crewroll.app"],
    ["a URL with a path", "https://api.crewroll.app/v1"],
    ["a URL with a query", "https://api.crewroll.app/?region=in"],
    ["a URL with a fragment", "https://api.crewroll.app/#mobile"],
    ["a malformed URL", "crewroll-api"],
  ])("rejects %s without echoing it", (_label, apiUrl) => {
    expectInvalidVariable(
      {
        EXPO_PUBLIC_API_URL: apiUrl,
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY,
      },
      "EXPO_PUBLIC_API_URL",
      apiUrl,
    );
  });

  it.each([
    "",
    "pk_test_",
    "pk_live_",
    "pk_prod_c3ludGhldGlj",
    "pk_test_has whitespace",
    "not-a-publishable-key",
  ])("rejects malformed Clerk key shape %p", (clerkPublishableKey) => {
    expectInvalidVariable(
      {
        EXPO_PUBLIC_API_URL: "https://api.crewroll.app",
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
      },
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
      clerkPublishableKey,
    );
  });

  it.each(["sk_test_c3ludGhldGlj", "sk_live_c3ludGhldGlj"])(
    "rejects secret key prefix %p without echoing it",
    (clerkPublishableKey) => {
      expectInvalidVariable(
        {
          EXPO_PUBLIC_API_URL: "https://api.crewroll.app",
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
        },
        "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
        clerkPublishableKey,
      );
    },
  );
});
