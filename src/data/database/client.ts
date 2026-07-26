import * as SQLite from 'expo-sqlite';

import { DatabaseInitializationError } from './errors';
import { migrateDatabase } from './migrations';

export const DEFAULT_DATABASE_NAME = 'airmesh.db';
const BUSY_TIMEOUT_MS = 5_000;

interface ForeignKeysRow {
  foreign_keys: number;
}

interface JournalModeRow {
  journal_mode: string;
}

export interface AirMeshDatabaseClient {
  initialize(): Promise<void>;
  connection(): Promise<SQLite.SQLiteDatabase>;
  transaction<T>(task: (database: SQLite.SQLiteDatabase) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface ExpoSqliteDatabaseClientOptions {
  databaseName?: string;
  directory?: string;
}

async function configureConnection(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
  `);

  const foreignKeys = await database.getFirstAsync<ForeignKeysRow>('PRAGMA foreign_keys');
  if (foreignKeys?.foreign_keys !== 1) {
    throw new DatabaseInitializationError('SQLite foreign-key enforcement could not be enabled.');
  }
  const journalMode = await database.getFirstAsync<JournalModeRow>('PRAGMA journal_mode');
  if (journalMode?.journal_mode.toLowerCase() !== 'wal') {
    throw new DatabaseInitializationError('SQLite WAL journal mode could not be enabled.');
  }
}

export class ExpoSqliteDatabaseClient implements AirMeshDatabaseClient {
  private readonly databaseName: string;
  private readonly directory: string | undefined;
  private databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
  private transactionDatabasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
  private transactionTail: Promise<void> = Promise.resolve();
  private initializationPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: ExpoSqliteDatabaseClientOptions = {}) {
    this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
    this.directory = options.directory;
  }

  initialize(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise.then(() => this.initialize());
    }
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeOnce();
    }
    return this.initializationPromise;
  }

  async connection(): Promise<SQLite.SQLiteDatabase> {
    await this.initialize();
    if (!this.databasePromise) {
      throw new DatabaseInitializationError('SQLite connection disappeared after initialization.');
    }
    return this.databasePromise;
  }

  async transaction<T>(
    task: (database: SQLite.SQLiteDatabase) => Promise<T>,
  ): Promise<T> {
    await this.initialize();
    const run = this.transactionTail.then(() => this.runTransaction(task));
    // SQLite has one writer. Keeping an explicit queue avoids racing BEGINs on
    // a shared connection while removing connection/configuration churn from
    // per-frame replay transactions.
    this.transactionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      const closing = this.closeOnce();
      let tracked!: Promise<void>;
      tracked = closing.finally(() => {
        if (this.closePromise === tracked) this.closePromise = null;
      });
      this.closePromise = tracked;
    }
    return this.closePromise;
  }

  private async initializeOnce(): Promise<void> {
    try {
      const database = await this.openBaseConnection();
      await configureConnection(database);
      await migrateDatabase(database);
    } catch (error) {
      const databasePromise = this.databasePromise;
      this.databasePromise = null;
      this.initializationPromise = null;
      if (databasePromise) {
        try {
          const database = await databasePromise;
          await database.closeAsync();
        } catch (closeError) {
          throw new DatabaseInitializationError(
            'Database initialization failed and its connection could not be closed.',
            { cause: new AggregateError([error, closeError]) },
          );
        }
      }
      if (error instanceof DatabaseInitializationError) {
        throw error;
      }
      throw new DatabaseInitializationError('Failed to initialize the CrewRoll database.', {
        cause: error,
      });
    }
  }

  private openBaseConnection(): Promise<SQLite.SQLiteDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = SQLite.openDatabaseAsync(
        this.databaseName,
        undefined,
        this.directory,
      );
    }
    return this.databasePromise;
  }

  private async runTransaction<T>(
    task: (database: SQLite.SQLiteDatabase) => Promise<T>,
  ): Promise<T> {
    const transactionDatabase = await this.openTransactionConnection();
    await transactionDatabase.execAsync('BEGIN IMMEDIATE');
    try {
      const result = await task(transactionDatabase);
      await transactionDatabase.execAsync('COMMIT');
      return result;
    } catch (error) {
      try {
        await transactionDatabase.execAsync('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'SQLite transaction failed and could not be rolled back.',
        );
      }
      throw error;
    }
  }

  private openTransactionConnection(): Promise<SQLite.SQLiteDatabase> {
    if (!this.transactionDatabasePromise) {
      const opening = (async () => {
        const database = await SQLite.openDatabaseAsync(
          this.databaseName,
          { useNewConnection: true },
          this.directory,
        );
        try {
          await configureConnection(database);
          return database;
        } catch (error) {
          try {
            await database.closeAsync();
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              'SQLite transaction connection configuration failed and it could not be closed.',
            );
          }
          throw error;
        }
      })();
      this.transactionDatabasePromise = opening;
      void opening.catch(() => {
        if (this.transactionDatabasePromise === opening) {
          this.transactionDatabasePromise = null;
        }
      });
    }
    return this.transactionDatabasePromise;
  }

  private async closeOnce(): Promise<void> {
    await this.transactionTail;
    const connections = [this.databasePromise, this.transactionDatabasePromise]
      .filter((connection): connection is Promise<SQLite.SQLiteDatabase> => connection !== null);
    this.databasePromise = null;
    this.transactionDatabasePromise = null;
    this.initializationPromise = null;
    this.transactionTail = Promise.resolve();

    const results = await Promise.allSettled(
      connections.map(async (connection) => (await connection).closeAsync()),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'CrewRoll SQLite connections could not be closed.');
    }
  }
}

export const databaseClient = new ExpoSqliteDatabaseClient();
