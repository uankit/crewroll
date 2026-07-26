import { PersistenceDecodingError } from '../database/errors';
import type { JsonValue } from '../types';

export function requiredString(entity: string, field: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new PersistenceDecodingError(entity, field, value);
  }
  return value;
}

export function nullableString(
  entity: string,
  field: string,
  value: unknown,
): string | null {
  if (value === null) {
    return null;
  }
  return requiredString(entity, field, value);
}

export function requiredNumber(entity: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PersistenceDecodingError(entity, field, value);
  }
  return value;
}

export function nullableNumber(
  entity: string,
  field: string,
  value: unknown,
): number | null {
  if (value === null) {
    return null;
  }
  return requiredNumber(entity, field, value);
}

export function sqliteBoolean(entity: string, field: string, value: unknown): boolean {
  if (value !== 0 && value !== 1) {
    throw new PersistenceDecodingError(entity, field, value);
  }
  return value === 1;
}

export function enumValue<const T extends readonly string[]>(
  entity: string,
  field: string,
  value: unknown,
  allowed: T,
): T[number] {
  const parsed = requiredString(entity, field, value);
  if (!allowed.includes(parsed)) {
    throw new PersistenceDecodingError(entity, field, value);
  }
  return parsed as T[number];
}

function normalizeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('JSON numbers must be finite.');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }

  const normalized: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalizeJson(value[key]);
  }
  return normalized;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === 'object') {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

export function encodeJson(value: JsonValue): string {
  return JSON.stringify(normalizeJson(value));
}

export function encodeNullableJson(value: JsonValue | null): string | null {
  return value === null ? null : encodeJson(value);
}

export function decodeJson(entity: string, field: string, value: unknown): JsonValue {
  const source = requiredString(entity, field, value);
  try {
    const parsed: unknown = JSON.parse(source);
    if (!isJsonValue(parsed)) {
      throw new TypeError('Decoded value is not JSON-compatible.');
    }
    return parsed;
  } catch (error) {
    throw new PersistenceDecodingError(entity, field, value, { cause: error });
  }
}

export function decodeNullableJson(
  entity: string,
  field: string,
  value: unknown,
): JsonValue | null {
  return value === null ? null : decodeJson(entity, field, value);
}

