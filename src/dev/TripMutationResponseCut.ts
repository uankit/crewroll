import * as SecureStore from "expo-secure-store";

import { TripTransportProblem } from "../application/trips/CreateImmediateTrip";
import type {
  AcceptedTripMutationKind,
  AcceptedTripMutationResponsePort,
} from "../application/trips/ports";

const ARM_KEY = "crewroll.dev.accepted-response-cut.v1";

export interface ResponseCutArmStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

type ResponseCutArm = Readonly<{
  version: 1;
  kind: AcceptedTripMutationKind;
}>;

function parseArm(value: string | null): ResponseCutArm | null {
  if (value === null) return null;
  try {
    const candidate: unknown = JSON.parse(value);
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Reflect.ownKeys(candidate).length !== 2
    ) {
      return null;
    }
    const record = candidate as Record<string, unknown>;
    if (
      record.version !== 1 ||
      (record.kind !== "CREATE" &&
        record.kind !== "JOIN" &&
        record.kind !== "SET_READINESS" &&
        record.kind !== "START")
    ) {
      return null;
    }
    return Object.freeze({ version: 1, kind: record.kind });
  } catch {
    return null;
  }
}

export class DevelopmentTripMutationResponseCut implements AcceptedTripMutationResponsePort {
  private pending = Promise.resolve();
  private createFollowUpCommandId: string | null = null;

  constructor(private readonly store: ResponseCutArmStore) {}

  async arm(kind: AcceptedTripMutationKind): Promise<void> {
    await this.serialized(async () => {
      this.createFollowUpCommandId = null;
      await this.store.write(JSON.stringify({ version: 1, kind }));
    });
  }

  async clear(): Promise<void> {
    await this.serialized(async () => {
      this.createFollowUpCommandId = null;
      await this.store.clear();
    });
  }

  async afterAccepted(
    input: Readonly<{
      kind: AcceptedTripMutationKind;
      commandId: string;
    }>,
  ): Promise<void> {
    let cut = false;
    await this.serialized(async () => {
      if (
        input.kind === "CREATE" &&
        this.createFollowUpCommandId === input.commandId
      ) {
        this.createFollowUpCommandId = null;
        cut = true;
        return;
      }
      const arm = parseArm(await this.store.read());
      if (arm?.kind !== input.kind) return;
      await this.store.clear();
      if (input.kind === "CREATE") {
        this.createFollowUpCommandId = input.commandId;
      }
      cut = true;
    });
    if (cut) throw new TripTransportProblem();
  }

  private async serialized(operation: () => Promise<void>): Promise<void> {
    const current = this.pending.catch(() => undefined).then(operation);
    this.pending = current;
    await current;
  }
}

export function createExpoResponseCutArmStore(): ResponseCutArmStore {
  return Object.freeze({
    read: () => SecureStore.getItemAsync(ARM_KEY),
    write: (value: string) => SecureStore.setItemAsync(ARM_KEY, value),
    clear: () => SecureStore.deleteItemAsync(ARM_KEY),
  });
}
