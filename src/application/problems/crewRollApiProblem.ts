import type { ProblemCode } from "@crewroll/contracts";

type ServerProvenance = Readonly<{ status: number }>;
const provenance = new WeakMap<CrewRollApiProblem, ServerProvenance>();

export class CrewRollApiProblem extends Error {
  readonly kind = "API_PROBLEM";

  constructor(
    readonly code: ProblemCode,
    server?: ServerProvenance,
  ) {
    super(code);
    this.name = "CrewRollApiProblem";
    if (server !== undefined) provenance.set(this, server);
  }

  get serverStatus(): number | null {
    return provenance.get(this)?.status ?? null;
  }
}
