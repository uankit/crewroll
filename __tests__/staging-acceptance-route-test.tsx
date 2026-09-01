import { Redirect } from "expo-router";

import {
  acceptanceRouteEnabled,
  StagingAcceptanceGate,
} from "../app/dev/staging-acceptance";
import { composeDevelopmentAcceptance } from "../src/bootstrap/DevelopmentAcceptance";

describe("staging acceptance route production isolation", () => {
  it("redirects synchronously before rendering any development surface", () => {
    expect(acceptanceRouteEnabled(false)).toBe(false);
    const result = StagingAcceptanceGate({ development: false });
    expect(result.type).toBe(Redirect);
    expect(result.props).toEqual({ href: "/", withAnchor: true });
  });

  it("composes preview and production without token, dev import, arm store, or actions", () => {
    const getToken = jest.fn(async () => "private-token");
    const readArmStore = jest.fn();
    const importDevelopmentImplementation = jest.fn(() => {
      readArmStore();
      return {
        afterAccepted: jest.fn(),
        arm: jest.fn(),
        clear: jest.fn(),
        inspectClaims: jest.fn(async () => {
          await getToken();
          return null;
        }),
      };
    });
    const composition = composeDevelopmentAcceptance(
      false,
      importDevelopmentImplementation,
    );
    expect(composition).toBeNull();
    expect(importDevelopmentImplementation).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    expect(readArmStore).not.toHaveBeenCalled();
  });
});
