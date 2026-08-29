import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import type { Database } from "./schema/tables.js";

export function createDatabase(connectionString: string): Kysely<Database> {
  if (connectionString.length === 0) {
    throw new Error("A PostgreSQL connection string is required");
  }

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        application_name: "crewroll-control-plane",
        connectionString,
        max: 10,
      }),
    }),
  });
}
