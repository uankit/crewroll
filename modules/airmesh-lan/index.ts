import { requireNativeModule } from 'expo';

interface AirMeshLanNativeModule {
  getIPv4AddressesAsync(): Promise<string[]>;
  /** iOS-only. The JavaScript policy never calls this on other platforms. */
  excludeFromBackupAsync(locations: string[]): Promise<void>;
}

export default requireNativeModule<AirMeshLanNativeModule>('AirMeshLan');
