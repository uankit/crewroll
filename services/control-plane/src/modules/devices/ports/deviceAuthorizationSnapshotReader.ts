import type {
  CommandIdentity,
  ForegroundDeviceSnapshot,
  RegistrationAuthorizationSnapshot,
} from "../types.js";

export interface DeviceAuthorizationSnapshotReader {
  readForegroundDevice(
    clerkSubject: string,
    deviceId: string,
    command: CommandIdentity,
    now: Date,
  ): Promise<ForegroundDeviceSnapshot | null>;
  readRegistration(
    clerkSubject: string,
    installationId: string,
    command: CommandIdentity,
    now: Date,
  ): Promise<RegistrationAuthorizationSnapshot>;
}
