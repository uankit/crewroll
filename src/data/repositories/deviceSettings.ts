import {
  databaseClient,
  type AirMeshDatabaseClient,
} from '../database/client';
import type {
  DeviceSettingRecord,
  JsonValue,
} from '../types';
import type { DeviceSettingsRepository } from './contracts';
import {
  decodeJson,
  encodeJson,
  requiredNumber,
  requiredString,
} from './rowMapping';

interface DeviceSettingRow {
  key: unknown;
  value_json: unknown;
  updated_at: unknown;
}

function mapSetting<T extends JsonValue = JsonValue>(
  row: DeviceSettingRow,
): DeviceSettingRecord<T> {
  return {
    key: requiredString('DeviceSetting', 'key', row.key),
    value: decodeJson('DeviceSetting', 'value_json', row.value_json) as T,
    updatedAt: requiredNumber('DeviceSetting', 'updated_at', row.updated_at),
  };
}

export class SqliteDeviceSettingsRepository implements DeviceSettingsRepository {
  constructor(private readonly client: AirMeshDatabaseClient = databaseClient) {}

  async get<T extends JsonValue = JsonValue>(
    key: string,
  ): Promise<DeviceSettingRecord<T> | null> {
    const row = await (await this.client.connection()).getFirstAsync<DeviceSettingRow>(
      'SELECT key, value_json, updated_at FROM device_settings WHERE key = ?',
      key,
    );
    return row ? mapSetting<T>(row) : null;
  }

  async set<T extends JsonValue = JsonValue>(record: DeviceSettingRecord<T>): Promise<void> {
    await (await this.client.connection()).runAsync(
      `INSERT INTO device_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      [record.key, encodeJson(record.value), record.updatedAt],
    );
  }

  async remove(key: string): Promise<boolean> {
    const result = await (await this.client.connection()).runAsync(
      'DELETE FROM device_settings WHERE key = ?',
      key,
    );
    return result.changes > 0;
  }

  async list(): Promise<DeviceSettingRecord[]> {
    const rows = await (await this.client.connection()).getAllAsync<DeviceSettingRow>(
      'SELECT key, value_json, updated_at FROM device_settings ORDER BY key ASC',
    );
    return rows.map((row) => mapSetting(row));
  }
}

