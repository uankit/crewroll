import { installCrewRollFormats } from "@crewroll/contracts";
import {
  ActivateTripCommandSchema,
  AssetPageSchema,
  CreateTripKeyCommandSchema,
  CreateTripKeyResultSchema,
  DeactivateTripCommandSchema,
  DiscardProvisionalTripKeyCommandSchema,
  DurableEngineSnapshotSchema,
  EnsureDeviceIdentityCommandSchema,
  ImportTripKeyCommandSchema,
  InstallDeviceSessionCommandSchema,
  ListAssetsQuerySchema,
  NativeDeviceIdentitySchema,
  ReconcileNowCommandSchema,
  RetryCommandSchema,
  RevisionInvalidationSchema,
  SetTransferPolicyCommandSchema,
  WrapTripKeyCommandSchema,
  WrapTripKeyResultSchema,
  type ActivateTripCommand,
  type AssetPage,
  type CreateTripKeyCommand,
  type CreateTripKeyResult,
  type DeactivateTripCommand,
  type DiscardProvisionalTripKeyCommand,
  type DurableEngineSnapshot,
  type EnsureDeviceIdentityCommand,
  type ImportTripKeyCommand,
  type InstallDeviceSessionCommand,
  type ListAssetsQuery,
  type NativeDeviceIdentity,
  type ReconcileNowCommand,
  type RetryCommand,
  type RevisionInvalidation,
  type SetTransferPolicyCommand,
  type WrapTripKeyCommand,
  type WrapTripKeyResult,
} from "@crewroll/contracts/native/protocol";
import { FormatRegistry, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  getCrewRollTransferNativeModule,
  type CrewRollTransferEventSubscription,
  type CrewRollTransferNativeModule,
} from "../../../modules/crewroll-transfer";

installCrewRollFormats(FormatRegistry);

export class CrewRollTransferProtocolError extends Error {
  readonly code = "ERR_CREWROLL_NATIVE_PROTOCOL";

  constructor(readonly operation: string) {
    super(`CrewRoll rejected invalid ${operation} at the native boundary.`);
    this.name = "CrewRollTransferProtocolError";
  }
}

function parse<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  operation: string,
): Static<Schema> {
  if (!Value.Check(schema, value)) {
    throw new CrewRollTransferProtocolError(operation);
  }
  return value as Static<Schema>;
}

export interface CrewRollTransferPort {
  ensureDeviceIdentity(
    command: EnsureDeviceIdentityCommand,
  ): Promise<NativeDeviceIdentity>;
  installDeviceSession(command: InstallDeviceSessionCommand): Promise<void>;
  createTripKey(command: CreateTripKeyCommand): Promise<CreateTripKeyResult>;
  discardProvisionalTripKey(
    command: DiscardProvisionalTripKeyCommand,
  ): Promise<void>;
  wrapTripKey(command: WrapTripKeyCommand): Promise<WrapTripKeyResult>;
  importTripKey(command: ImportTripKeyCommand): Promise<void>;
  activateTrip(command: ActivateTripCommand): Promise<void>;
  deactivateTrip(command: DeactivateTripCommand): Promise<void>;
  setTransferPolicy(command: SetTransferPolicyCommand): Promise<void>;
  reconcileNow(command: ReconcileNowCommand): Promise<void>;
  retry(command: RetryCommand): Promise<void>;
  getSnapshot(): Promise<DurableEngineSnapshot>;
  listAssets(query: ListAssetsQuery): Promise<AssetPage>;
  subscribeToInvalidations(
    listener: (event: RevisionInvalidation) => void,
  ): CrewRollTransferEventSubscription;
}

type NativeModuleProvider = () => CrewRollTransferNativeModule;

export function createCrewRollTransferPort(
  getNativeModule: NativeModuleProvider,
): CrewRollTransferPort {
  return {
    async ensureDeviceIdentity(command) {
      const parsed = parse(
        EnsureDeviceIdentityCommandSchema,
        command,
        "ensureDeviceIdentity command",
      );
      const result: unknown =
        await getNativeModule().ensureDeviceIdentity(parsed);
      return parse(
        NativeDeviceIdentitySchema,
        result,
        "ensureDeviceIdentity result",
      );
    },
    async installDeviceSession(command) {
      const parsed = parse(
        InstallDeviceSessionCommandSchema,
        command,
        "installDeviceSession command",
      );
      await getNativeModule().installDeviceSession(parsed);
    },
    async createTripKey(command) {
      const parsed = parse(
        CreateTripKeyCommandSchema,
        command,
        "createTripKey command",
      );
      const result: unknown = await getNativeModule().createTripKey(parsed);
      return parse(CreateTripKeyResultSchema, result, "createTripKey result");
    },
    async discardProvisionalTripKey(command) {
      const parsed = parse(
        DiscardProvisionalTripKeyCommandSchema,
        command,
        "discardProvisionalTripKey command",
      );
      await getNativeModule().discardProvisionalTripKey(parsed);
    },
    async wrapTripKey(command) {
      const parsed = parse(
        WrapTripKeyCommandSchema,
        command,
        "wrapTripKey command",
      );
      const result: unknown = await getNativeModule().wrapTripKey(parsed);
      return parse(WrapTripKeyResultSchema, result, "wrapTripKey result");
    },
    async importTripKey(command) {
      const parsed = parse(
        ImportTripKeyCommandSchema,
        command,
        "importTripKey command",
      );
      await getNativeModule().importTripKey(parsed);
    },
    async activateTrip(command) {
      const parsed = parse(
        ActivateTripCommandSchema,
        command,
        "activateTrip command",
      );
      await getNativeModule().activateTrip(parsed);
    },
    async deactivateTrip(command) {
      const parsed = parse(
        DeactivateTripCommandSchema,
        command,
        "deactivateTrip command",
      );
      await getNativeModule().deactivateTrip(parsed);
    },
    async setTransferPolicy(command) {
      const parsed = parse(
        SetTransferPolicyCommandSchema,
        command,
        "setTransferPolicy command",
      );
      await getNativeModule().setTransferPolicy(parsed);
    },
    async reconcileNow(command) {
      const parsed = parse(
        ReconcileNowCommandSchema,
        command,
        "reconcileNow command",
      );
      await getNativeModule().reconcileNow(parsed);
    },
    async retry(command) {
      const parsed = parse(RetryCommandSchema, command, "retry command");
      await getNativeModule().retry(parsed);
    },
    async getSnapshot() {
      const result: unknown = await getNativeModule().getSnapshot();
      return parse(DurableEngineSnapshotSchema, result, "getSnapshot result");
    },
    async listAssets(query) {
      const parsed = parse(ListAssetsQuerySchema, query, "listAssets query");
      const result: unknown = await getNativeModule().listAssets(parsed);
      return parse(AssetPageSchema, result, "listAssets result");
    },
    subscribeToInvalidations(listener) {
      return getNativeModule().addListener("engineInvalidated", (event) => {
        listener(
          parse(RevisionInvalidationSchema, event, "engineInvalidated event"),
        );
      });
    },
  };
}

export const crewRollTransfer = createCrewRollTransferPort(
  getCrewRollTransferNativeModule,
);

export type { CrewRollTransferEventSubscription, CrewRollTransferNativeModule };
