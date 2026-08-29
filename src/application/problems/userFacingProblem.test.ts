import { ProblemCodeSchema } from "@crewroll/contracts";

import {
  toUserFacingProblem,
  transportUnavailableProblem,
  userFacingProblems,
} from "./userFacingProblem";

describe("user-facing problem registry", () => {
  it("covers every canonical problem code with safe stable copy", () => {
    const codes = ProblemCodeSchema.anyOf.map((candidate) => candidate.const);

    expect(Object.keys(userFacingProblems).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const problem = toUserFacingProblem(code);
      expect(problem.message).toMatch(/^[A-Z]/);
      expect(problem.message).not.toMatch(
        /http|clerk|request|path|hash|bearer|token|envelope/i,
      );
    }
  });

  it("uses stable privacy-safe copy for an unavailable transport", () => {
    expect(transportUnavailableProblem).toEqual({
      message:
        "CrewRoll cannot connect right now. Check your connection and try again.",
      tone: "warning",
    });
  });
});
