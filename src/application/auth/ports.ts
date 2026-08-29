import type { DeviceResponse, RegisterDeviceBody } from "@crewroll/contracts";

export interface SessionTokenSource {
  getToken(): Promise<string>;
}

export interface DeviceRegistrationPort {
  registerDevice(
    commandId: string,
    body: RegisterDeviceBody,
  ): Promise<DeviceResponse>;
}
