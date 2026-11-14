import {
  CompiledQuery,
  PostgresDialect,
  PostgresDriver,
  type DatabaseConnection,
  type PostgresDialectConfig,
  type TransactionSettings,
} from "kysely";

export interface TransactionTimeouts {
  readonly statementTimeoutMillis?: number;
  readonly lockTimeoutMillis?: number;
  readonly idleTransactionTimeoutMillis?: number;
}

class TransactionScopedPostgresDriver extends PostgresDriver {
  readonly #configure: CompiledQuery | undefined;

  constructor(config: PostgresDialectConfig, timeouts: TransactionTimeouts) {
    super(config);
    const settings = [
      ["statement_timeout", timeouts.statementTimeoutMillis],
      ["lock_timeout", timeouts.lockTimeoutMillis],
      [
        "idle_in_transaction_session_timeout",
        timeouts.idleTransactionTimeoutMillis,
      ],
    ] as const;
    const configured = settings.flatMap(([name, value]) =>
      value === undefined ? [] : [{ name, value }],
    );
    for (const { value } of configured) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
        throw new Error("Database timeouts must be positive milliseconds");
    }
    this.#configure = configured.length
      ? CompiledQuery.raw(
          `select ${configured.map(({ name }, index) => `set_config('${name}', $${index + 1}, true)`).join(", ")}`,
          configured.map(({ value }) => `${value}ms`),
        )
      : undefined;
  }

  override async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    await super.beginTransaction(connection, settings);
    if (!this.#configure) return;
    try {
      // Hyperdrive returns origin connections after each transaction. Startup
      // settings cannot provide this guarantee: configure the same transaction.
      await connection.executeQuery(this.#configure);
    } catch (error) {
      // Kysely considers BEGIN unfinished until this method resolves. It will
      // not roll back a failure here, so release our transaction before rethrow.
      try {
        await super.rollbackTransaction(connection);
      } catch {
        // A broken socket is discarded by boundedPostgresPool. Preserve the
        // original failure rather than retrying a transaction of unknown state.
      }
      throw error;
    }
  }
}

/** Server-enforced statement/lock/idle limits, not a whole-transaction timer. */
export class TransactionScopedPostgresDialect extends PostgresDialect {
  readonly #config: PostgresDialectConfig;
  readonly #timeouts: TransactionTimeouts;

  constructor(config: PostgresDialectConfig, timeouts: TransactionTimeouts) {
    super(config);
    this.#config = config;
    this.#timeouts = timeouts;
  }

  override createDriver(): PostgresDriver {
    return new TransactionScopedPostgresDriver(this.#config, this.#timeouts);
  }
}
