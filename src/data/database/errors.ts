export class PersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PersistenceError';
  }
}

export class DatabaseInitializationError extends PersistenceError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DatabaseInitializationError';
  }
}

export class UnsupportedDatabaseVersionError extends DatabaseInitializationError {
  constructor(currentVersion: number, supportedVersion: number) {
    super(
      `Database schema version ${currentVersion} is newer than supported version ${supportedVersion}.`,
    );
    this.name = 'UnsupportedDatabaseVersionError';
  }
}

export class PersistenceDecodingError extends PersistenceError {
  constructor(entity: string, field: string, value: unknown, options?: ErrorOptions) {
    super(`Invalid ${entity}.${field} value in SQLite: ${String(value)}`, options);
    this.name = 'PersistenceDecodingError';
  }
}

export class RecordNotFoundError extends PersistenceError {
  constructor(entity: string, id: string) {
    super(`${entity} '${id}' was not found.`);
    this.name = 'RecordNotFoundError';
  }
}

export class ImmutableRecordConflictError extends PersistenceError {
  constructor(entity: string, id: string) {
    super(`${entity} '${id}' already exists with different immutable content.`);
    this.name = 'ImmutableRecordConflictError';
  }
}

export class SequenceConflictError extends PersistenceError {
  constructor(tripId: string, originDeviceId: string, originSequence: number) {
    super(
      `Trip '${tripId}' already has a different operation at ${originDeviceId}:${originSequence}.`,
    );
    this.name = 'SequenceConflictError';
  }
}
