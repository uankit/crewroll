import type {
  ActivateTripCommand,
  AssetPage,
  CreateTripKeyCommand,
  CreateTripKeyResult,
  DeactivateTripCommand,
  DurableEngineSnapshot,
  ImportTripKeyCommand,
  InstallDeviceSessionCommand,
  ListAssetsQuery,
  NativeDeviceIdentity,
  ReconcileNowCommand,
  RetryCommand,
  RevisionInvalidation,
  SetTransferPolicyCommand,
  WrapTripKeyCommand,
  WrapTripKeyResult,
} from "@crewroll/contracts/native/protocol";

export type CrewRollTransferEventSubscription = Readonly<{
  remove(): void;
}>;

export interface CrewRollTransferNativeModule {
  ensureDeviceIdentity(): Promise<NativeDeviceIdentity>;
  installDeviceSession(command: InstallDeviceSessionCommand): Promise<void>;
  createTripKey(command: CreateTripKeyCommand): Promise<CreateTripKeyResult>;
  wrapTripKey(command: WrapTripKeyCommand): Promise<WrapTripKeyResult>;
  importTripKey(command: ImportTripKeyCommand): Promise<void>;
  activateTrip(command: ActivateTripCommand): Promise<void>;
  deactivateTrip(command: DeactivateTripCommand): Promise<void>;
  setTransferPolicy(command: SetTransferPolicyCommand): Promise<void>;
  reconcileNow(command: ReconcileNowCommand): Promise<void>;
  retry(command: RetryCommand): Promise<void>;
  getSnapshot(): Promise<DurableEngineSnapshot>;
  listAssets(query: ListAssetsQuery): Promise<AssetPage>;
  addListener(
    eventName: "engineInvalidated",
    listener: (event: RevisionInvalidation) => void,
  ): CrewRollTransferEventSubscription;
}
