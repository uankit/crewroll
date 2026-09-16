import type { DeviceResponse, RegisterDeviceBody } from "@crewroll/contracts";

export interface SessionTokenSource {
  getToken(options?: Readonly<{ skipCache: boolean }>): Promise<string>;
}

export interface DeviceRegistrationPort {
  registerDevice(
    commandId: string,
    body: RegisterDeviceBody,
  ): Promise<DeviceResponse>;
}
