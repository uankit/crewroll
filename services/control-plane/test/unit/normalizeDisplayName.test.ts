import { describe, expect, it } from "vitest";

import { normalizeDisplayName } from "../../src/shared/identity/normalizeDisplayName.js";

describe("normalizeDisplayName", () => {
  it.each([
    [
      {
        firstName: "Ignored",
        fullName: "  Full\t Name  ",
        lastName: "Person",
        username: "ignored",
      },
      "Full Name",
    ],
    [
      {
        firstName: "First",
        fullName: null,
        lastName: "Last",
        username: "ignored",
      },
      "First Last",
    ],
    [
      {
        firstName: null,
        fullName: null,
        lastName: null,
        username: "crew_member",
      },
      "crew_member",
    ],
    [
      { firstName: null, fullName: null, lastName: null, username: null },
      "CrewRoll member",
    ],
    [
      {
        firstName: null,
        fullName: " Jose\u0301 ",
        lastName: null,
        username: null,
      },
      "José",
    ],
    [
      {
        firstName: null,
        fullName: "\u2003Alpha\u00a0\u2009Beta\u3000",
        lastName: null,
        username: null,
      },
      "Alpha Beta",
    ],
  ] as const)("selects and normalizes profile names", (profile, expected) => {
    expect(normalizeDisplayName(profile)).toBe(expected);
  });

  it("caps names at 80 Unicode code points without splitting an astral symbol", () => {
    const eighty = "🙂".repeat(80);
    const eightyOne = `${eighty}x`;

    expect(
      Array.from(
        normalizeDisplayName({
          firstName: null,
          fullName: eighty,
          lastName: null,
          username: null,
        }),
      ),
    ).toHaveLength(80);
    expect(
      normalizeDisplayName({
        firstName: null,
        fullName: eightyOne,
        lastName: null,
        username: null,
      }),
    ).toBe(eighty);
  });
});
