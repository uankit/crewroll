import type { ProblemCode } from "@crewroll/contracts";

export class CrewRollApiProblem extends Error {
  readonly kind = "API_PROBLEM";

  constructor(readonly code: ProblemCode) {
    super(code);
    this.name = "CrewRollApiProblem";
  }
}
