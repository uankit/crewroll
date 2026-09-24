import type {
  EraseAccountCommand,
  ActivateTripCommand,
  AssetPage,
  ClearDeviceSessionCommand,
  CreateTripKeyCommand,
  CreateTripKeyResult,
  DeactivateTripCommand,
  DiscardProvisionalTripKeyCommand,
  DurableEngineSnapshot,
  EnsureDeviceIdentityCommand,
  ImportTripKeyCommand,
  InstallDeviceSessionCommand,
  ListAssetsQuery,
  NativeDeviceIdentity,
  ReconcileNowCommand,
  RetryCommand,
  RevisionInvalidation,
  RestoreDeviceSessionCommand,
  RestoredDeviceSession,
  SetTransferPolicyCommand,
  WrapTripKeyCommand,
  WrapTripKeyResult,
} from "@crewroll/contracts/native/protocol";

export type CrewRollTransferEventSubscription = Readonly<{
  remove(): void;
}>;

export interface CrewRollTransferNativeModule {
  eraseAccount?(command: EraseAccountCommand): Promise<void>;
  restoreDeviceSession?(
    command: RestoreDeviceSessionCommand,
  ): Promise<RestoredDeviceSession>;
  ensureDeviceIdentity(
    command: EnsureDeviceIdentityCommand,
  ): Promise<NativeDeviceIdentity>;
  installDeviceSession(command: InstallDeviceSessionCommand): Promise<void>;
  clearDeviceSession(command: ClearDeviceSessionCommand): Promise<void>;
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
  addListener(
    eventName: "engineInvalidated",
    listener: (event: RevisionInvalidation) => void,
  ): CrewRollTransferEventSubscription;
}
