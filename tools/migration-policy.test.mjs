import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeMigrationModules } from "./migration-policy.mjs";

const migrationPath = "services/control-plane/src/db/migrations/001_initial.ts";

async function analyzeSource(t, source) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "crewroll-b2b-ii-a-"));
  t.after(async () => rm(rootPath, { force: true, recursive: true }));
  const targetPath = path.join(rootPath, migrationPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, source, "utf8");

  return analyzeMigrationModules({
    rootPath,
    migrationFiles: [migrationPath],
  });
}

const typeImport = 'import type { Kysely } from "kysely";';
const sqlImports = `
  import { sql } from "kysely";
  import type { Kysely } from "kysely";
`;
const safeCreate = `
  await db.schema
    .createTable("users")
    .addColumn("id", "uuid")
    .execute();
`;
const safeDrop = 'await db.schema.dropTable("users").execute();';

function migrationSource({
  imports = typeImport,
  declarations = "",
  upBody = safeCreate,
  downBody = safeDrop,
  upParameter = "db: Kysely<unknown>",
  downParameter = "db: Kysely<unknown>",
} = {}) {
  return `
    ${imports}
    ${declarations}
    export async function up(${upParameter}): Promise<void> {
      ${upBody}
    }
    export async function down(${downParameter}): Promise<void> {
      ${downBody}
    }
  `;
}

function compareFindings(left, right) {
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    left.code.localeCompare(right.code)
  );
}

function assertFindingShape(result) {
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.findings));
  assert.deepEqual(result.findings, [...result.findings].sort(compareFindings));
  for (const finding of result.findings) {
    assert.ok(Object.isFrozen(finding));
    assert.deepEqual(Object.keys(finding).sort(), [
      "code",
      "column",
      "line",
      "path",
    ]);
    assert.equal(finding.path, migrationPath);
    assert.ok(Number.isInteger(finding.line) && finding.line > 0);
    assert.ok(Number.isInteger(finding.column) && finding.column > 0);
  }
}

async function assertRejected(t, source, expectedCode) {
  const result = await analyzeSource(t, source);
  assert.equal(result.migrationCount, 1);
  assertFindingShape(result);
  assert.ok(
    result.findings.some(({ code }) => code === expectedCode),
    `expected ${expectedCode}, received ${JSON.stringify(result.findings)}`,
  );
}

test("accepts one minimal closed migration module", async (t) => {
  const result = await analyzeSource(
    t,
    `
      import type { Kysely } from "kysely";

      export async function up(db: Kysely<unknown>): Promise<void> {
        await db.schema
          .createTable("users")
          .addColumn("id", "uuid")
          .execute();
      }

      export async function down(db: Kysely<unknown>): Promise<void> {
        await db.schema.dropTable("users").execute();
      }
    `,
  );

  assert.equal(result.migrationCount, 1);
  assert.deepEqual(result.findings, []);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.findings));
});

test("accepts only the exact bounded alter-table constraint grammar", async (t) => {
  const result = await analyzeSource(
    t,
    migrationSource({
      imports: sqlImports,
      upBody: `
        await db.schema
          .alterTable("devices")
          .dropConstraint("devices_authentication_key_check")
          .execute();
        await db.schema
          .alterTable("devices")
          .addCheckConstraint(
            "devices_authentication_key_check",
            sql\`octet_length(authentication_public_key) = 65\`,
          )
          .execute();
      `,
      downBody: `
        await db.schema
          .alterTable("devices")
          .dropConstraint("devices_authentication_key_check")
          .execute();
        await db.schema
          .alterTable("devices")
          .addCheckConstraint(
            "devices_authentication_key_check",
            sql\`octet_length(authentication_public_key) >= 33\`,
          )
          .execute();
      `,
    }),
  );

  assert.equal(result.migrationCount, 1);
  assert.deepEqual(result.findings, []);
});

test("accepts the bounded API3 alter-table column grammar", async (t) => {
  const result = await analyzeSource(
    t,
    migrationSource({
      imports: sqlImports,
      upBody: `
        await db.schema
          .alterTable("trip_members")
          .addColumn("full_photo_library_access", "boolean", (column) =>
            column.notNull().defaultTo(false),
          )
          .execute();
        await db.schema
          .alterTable("trips")
          .alterColumn("version", (column) => column.setDefault(1))
          .execute();
        await db.schema
          .alterTable("trips")
          .dropConstraint("trips_version_check")
          .execute();
        await db.schema
          .alterTable("trips")
          .addCheckConstraint("trips_version_check", sql\`version >= 1\`)
          .execute();
      `,
      downBody: `
        await db.schema
          .alterTable("trips")
          .dropConstraint("trips_version_check")
          .execute();
        await db.schema
          .alterTable("trips")
          .addCheckConstraint("trips_version_check", sql\`version >= 0\`)
          .execute();
        await db.schema
          .alterTable("trips")
          .alterColumn("version", (column) => column.setDefault(0))
          .execute();
        await db.schema
          .alterTable("trip_members")
          .dropColumn("full_photo_library_access")
          .execute();
      `,
    }),
  );

  assert.equal(result.migrationCount, 1);
  assert.deepEqual(result.findings, []);
});

test("rejects every widening of the API3 alter-table column grammar", async (t) => {
  const cases = [
    [
      "dynamic add-column table",
      "up",
      'await db.schema.alterTable(tableName).addColumn("access", "boolean", (column) => column.notNull().defaultTo(false)).execute();',
    ],
    [
      "dynamic add-column name",
      "up",
      'await db.schema.alterTable("members").addColumn(columnName, "boolean", (column) => column.notNull().defaultTo(false)).execute();',
    ],
    [
      "dynamic add-column type",
      "up",
      'await db.schema.alterTable("members").addColumn("access", columnType, (column) => column.notNull().defaultTo(false)).execute();',
    ],
    [
      "computed add-column type",
      "up",
      'await db.schema.alterTable("members").addColumn("access", "bool" + "ean", (column) => column.notNull().defaultTo(false)).execute();',
    ],
    [
      "other literal add-column type",
      "up",
      'await db.schema.alterTable("members").addColumn("access", "text", (column) => column.notNull().defaultTo(false)).execute();',
    ],
    [
      "missing add-column callback",
      "up",
      'await db.schema.alterTable("members").addColumn("access", "boolean").execute();',
    ],
    [
      "wrong add-column default",
      "up",
      'await db.schema.alterTable("members").addColumn("access", "boolean", (column) => column.notNull().defaultTo(true)).execute();',
    ],
    [
      "dynamic add-column default",
      "up",
      'await db.schema.alterTable("members").addColumn("access", "boolean", (column) => column.notNull().defaultTo(defaultValue)).execute();',
    ],
    [
      "reordered add-column callback",
      "up",
      'await db.schema.alterTable("members").addColumn("access", "boolean", (column) => column.defaultTo(false).notNull()).execute();',
    ],
    [
      "arbitrary add-column callback method",
      "up",
      'await db.schema.alterTable("members").addColumn("access", "boolean", (column) => column.notNull().unique().defaultTo(false)).execute();',
    ],
    [
      "raw add-column default",
      "up",
      'await db.schema.alterTable("members").addColumn("access", "boolean", (column) => column.notNull().defaultTo(sql.raw("false"))).execute();',
    ],
    [
      "effectful add-column callback",
      "up",
      'await db.schema.alterTable("members").addColumn("access", "boolean", (column) => { sideEffect(); return column.notNull().defaultTo(false); }).execute();',
    ],
    [
      "add column during down",
      "down",
      'await db.schema.alterTable("members").addColumn("access", "boolean", (column) => column.notNull().defaultTo(false)).execute();',
    ],
    [
      "dynamic alter-column name",
      "up",
      'await db.schema.alterTable("trips").alterColumn(columnName, (column) => column.setDefault(1)).execute();',
    ],
    [
      "wrong Kysely alter-column method",
      "up",
      'await db.schema.alterTable("trips").alterColumn("version", (column) => column.setDefaultTo(1)).execute();',
    ],
    [
      "non-binary alter-column default",
      "up",
      'await db.schema.alterTable("trips").alterColumn("version", (column) => column.setDefault(2)).execute();',
    ],
    [
      "dynamic alter-column default",
      "up",
      'await db.schema.alterTable("trips").alterColumn("version", (column) => column.setDefault(nextVersion)).execute();',
    ],
    [
      "raw alter-column default",
      "up",
      'await db.schema.alterTable("trips").alterColumn("version", (column) => column.setDefault(sql`1`)).execute();',
    ],
    [
      "alter-column callback suffix",
      "up",
      'await db.schema.alterTable("trips").alterColumn("version", (column) => column.setDefault(1).setNotNull()).execute();',
    ],
    [
      "effectful alter-column callback",
      "down",
      'await db.schema.alterTable("trips").alterColumn("version", (column) => { sideEffect(); return column.setDefault(0); }).execute();',
    ],
    [
      "dynamic drop-column name",
      "down",
      'await db.schema.alterTable("members").dropColumn(columnName).execute();',
    ],
    [
      "drop column during up",
      "up",
      'await db.schema.alterTable("members").dropColumn("access").execute();',
    ],
    [
      "add index",
      "up",
      'await db.schema.alterTable("members").addIndex("members_access_idx").execute();',
    ],
    [
      "drop index",
      "down",
      'await db.schema.alterTable("members").dropIndex("members_access_idx").execute();',
    ],
    [
      "new constraint method",
      "up",
      'await db.schema.alterTable("members").addUniqueConstraint("members_access_unique", ["access"]).execute();',
    ],
    [
      "combined alterations",
      "up",
      'await db.schema.alterTable("members").addColumn("access", "boolean", (column) => column.notNull().defaultTo(false)).alterColumn("version", (column) => column.setDefault(1)).execute();',
    ],
    [
      "execute argument",
      "down",
      'await db.schema.alterTable("members").dropColumn("access").execute("now");',
    ],
    [
      "execute chain suffix",
      "down",
      'await db.schema.alterTable("members").dropColumn("access").execute().dropColumn("late");',
    ],
    [
      "second execute",
      "up",
      'await db.schema.alterTable("trips").alterColumn("version", (column) => column.setDefault(1)).execute().execute();',
    ],
  ];

  for (const [name, mode, body] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({
          imports: sqlImports,
          ...(mode === "up" ? { upBody: body } : { downBody: body }),
        }),
        mode === "up"
          ? "MIGRATION_UP_OPAQUE_CALL"
          : "MIGRATION_DOWN_OPAQUE_CALL",
      ),
    );
  }
});

test("validates helper alterations in every reachable lifecycle context", async (t) => {
  const passingCases = [
    [
      "up-only add-column helper",
      migrationSource({
        declarations: `
          async function applyReadiness(db: Kysely<unknown>): Promise<void> {
            await db.schema
              .alterTable("trip_members")
              .addColumn("full_photo_library_access", "boolean", (column) =>
                column.notNull().defaultTo(false),
              )
              .execute();
          }
        `,
        upBody: "await applyReadiness(db);",
      }),
    ],
    [
      "down-only drop-column helper",
      migrationSource({
        declarations: `
          async function removeReadiness(db: Kysely<unknown>): Promise<void> {
            await db.schema
              .alterTable("trip_members")
              .dropColumn("full_photo_library_access")
              .execute();
          }
        `,
        downBody: "await removeReadiness(db);",
      }),
    ],
    [
      "shared direction-neutral constraint helper",
      migrationSource({
        declarations: `
          async function replaceConstraint(db: Kysely<unknown>): Promise<void> {
            await db.schema
              .alterTable("trips")
              .dropConstraint("trips_version_check")
              .execute();
          }
        `,
        upBody: "await replaceConstraint(db);",
        downBody: "await replaceConstraint(db);",
      }),
    ],
  ];

  for (const [name, source] of passingCases) {
    await t.test(name, async (subtest) => {
      const result = await analyzeSource(subtest, source);
      assert.deepEqual(result.findings, []);
    });
  }

  await t.test("shared add-column helper reaches down", (subtest) =>
    assertRejected(
      subtest,
      migrationSource({
        declarations: `
          async function applyReadiness(db: Kysely<unknown>): Promise<void> {
            await db.schema
              .alterTable("trip_members")
              .addColumn("full_photo_library_access", "boolean", (column) =>
                column.notNull().defaultTo(false),
              )
              .execute();
          }
        `,
        upBody: "await applyReadiness(db);",
        downBody: "await applyReadiness(db);",
      }),
      "MIGRATION_DOWN_OPAQUE_CALL",
    ),
  );

  await t.test("shared drop-column helper reaches up", (subtest) =>
    assertRejected(
      subtest,
      migrationSource({
        declarations: `
          async function removeReadiness(db: Kysely<unknown>): Promise<void> {
            await db.schema
              .alterTable("trip_members")
              .dropColumn("full_photo_library_access")
              .execute();
          }
        `,
        upBody: "await removeReadiness(db);",
        downBody: "await removeReadiness(db);",
      }),
      "MIGRATION_UP_OPAQUE_CALL",
    ),
  );
});

test("rejects every alter-table widening outside exact constraint replacement", async (t) => {
  const cases = [
    [
      "dynamic table",
      'await db.schema.alterTable(tableName).dropConstraint("check").execute();',
      "MIGRATION_UP_OPAQUE_CALL",
    ],
    [
      "dynamic constraint",
      'await db.schema.alterTable("devices").dropConstraint(checkName).execute();',
      "MIGRATION_UP_OPAQUE_CALL",
    ],
    [
      "opaque method",
      'await db.schema.alterTable("devices").renameColumn("key", "next_key").execute();',
      "MIGRATION_UP_OPAQUE_CALL",
    ],
    [
      "drop extra argument",
      'await db.schema.alterTable("devices").dropConstraint("check", "cascade").execute();',
      "MIGRATION_UP_OPAQUE_CALL",
    ],
    [
      "generic alter table",
      'await db.schema.alterTable<"devices">("devices").dropConstraint("check").execute();',
      "MIGRATION_UP_OPAQUE_CALL",
    ],
    [
      "generic constraint method",
      'await db.schema.alterTable("devices").dropConstraint<"check">("check").execute();',
      "MIGRATION_UP_OPAQUE_CALL",
    ],
    [
      "combined alterations",
      'await db.schema.alterTable("devices").dropConstraint("old").addCheckConstraint("new", sql`value > 0`).execute();',
      "MIGRATION_UP_OPAQUE_CALL",
    ],
    [
      "interpolated check",
      'await db.schema.alterTable("devices").addCheckConstraint("check", sql`value > ${db}`).execute();',
      "MIGRATION_SQL_SHAPE",
    ],
    [
      "executable check SQL",
      'await db.schema.alterTable("devices").addCheckConstraint("check", sql`value > 0; drop table devices`).execute();',
      "MIGRATION_SQL_SHAPE",
    ],
    [
      "raw check SQL",
      'await db.schema.alterTable("devices").addCheckConstraint("check", sql.raw("value > 0")).execute();',
      "MIGRATION_SQL_SHAPE",
    ],
    [
      "missing execute",
      'await db.schema.alterTable("devices").dropConstraint("check");',
      "MIGRATION_UP_OPAQUE_CALL",
    ],
  ];

  for (const [name, upBody, expectedCode] of cases) {
    await t.test(`up ${name}`, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({ imports: sqlImports, upBody }),
        expectedCode,
      ),
    );
    await t.test(`down ${name}`, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({ imports: sqlImports, downBody: upBody }),
        expectedCode === "MIGRATION_SQL_SHAPE"
          ? expectedCode
          : "MIGRATION_DOWN_OPAQUE_CALL",
      ),
    );
  }
});

test("accepts the full create-table, index, SQL, helper, and rollback grammar", async (t) => {
  const result = await analyzeSource(
    t,
    `
      import { sql } from "kysely";
      import type { Kysely } from "kysely";

      type MigrationDatabase = Kysely<unknown>;
      interface MigrationMarker { readonly kind: "migration"; }

      async function createAudit(db: MigrationDatabase): Promise<void> {
        await db.schema
          .createTable("audit")
          .addColumn("id", "uuid", (column) => column.primaryKey())
          .execute();
      }

      async function dropAudit(db: MigrationDatabase): Promise<void> {
        await db.schema.dropTable("audit").execute();
      }

      export async function up(db: MigrationDatabase): Promise<void> {
        await db.schema
          .createTable("users")
          .addColumn("id", "uuid", (column) => column.primaryKey())
          .addColumn("name", "text", (column) => column.notNull().unique())
          .addColumn("owner_id", "uuid", (column) =>
            column
              .references("owners.id")
              .onDelete("restrict")
              .onUpdate("cascade"),
          )
          .addColumn("rank", "integer", (column) => column.defaultTo(-1))
          .addColumn("enabled", "boolean", (column) => column.defaultTo(true))
          .addColumn("note", "text", (column) => column.defaultTo(null))
          .addColumn("created_at", "timestamptz", (column) =>
            column.notNull().defaultTo(sql\`now()\`),
          )
          .addColumn("score", "integer", (column) =>
            column.check(sql\`score >= 0\`),
          )
          .addColumn("sequence", "integer", (column) =>
            column.generatedAlwaysAsIdentity(),
          )
          .addPrimaryKeyConstraint("users_pk", ["id"])
          .addUniqueConstraint("users_name_unique", ["name"])
          .addForeignKeyConstraint(
            "users_owner_fk",
            ["owner_id"],
            "owners",
            ["id"],
            (foreignKey) =>
              foreignKey.onDelete("set null").onUpdate("no action"),
          )
          .addCheckConstraint(
            "users_name_check",
            sql\`char_length(name) > 0 and created_at is not null\`,
          )
          .execute();

        await db.schema
          .createIndex("users_name_idx")
          .unique()
          .on("users")
          .column("name")
          .column("enabled")
          .where("enabled", "=", true)
          .execute();

        await db.schema
          .createIndex("users_owner_rank_idx")
          .on("users")
          .columns(["owner_id", "rank"])
          .execute();

        await db.schema
          .createIndex("users_active_idx")
          .on("users")
          .column<"owner_id" | "deleted_at">("owner_id")
          .where("deleted_at", "is", null)
          .execute();

        await createAudit(db);
        return;
      }

      export async function down(db: MigrationDatabase): Promise<void> {
        await db.schema.dropIndex("users_active_idx").execute();
        await db.schema.dropIndex("users_owner_rank_idx").execute();
        await db.schema.dropIndex("users_name_idx").execute();
        await db.schema.dropTable("users").execute();
        await dropAudit(db);
        return;
      }
    `,
  );

  assert.equal(result.migrationCount, 1);
  assert.deepEqual(result.findings, []);
  assertFindingShape(result);
});

test("accepts every locked referential action and partial-index operator", async (t) => {
  for (const action of [
    "cascade",
    "restrict",
    "set null",
    "set default",
    "no action",
  ]) {
    await t.test(`referential action ${action}`, async (subtest) => {
      const result = await analyzeSource(
        subtest,
        migrationSource({
          upBody: `
            await db.schema
              .createTable("children")
              .addColumn("parent_id", "uuid", (column) =>
                column.references("parents.id").onDelete("${action}"),
              )
              .addForeignKeyConstraint(
                "children_parent_fk",
                ["parent_id"],
                "parents",
                ["id"],
                (foreignKey) => foreignKey.onUpdate("${action}"),
              )
              .execute();
          `,
          downBody: 'await db.schema.dropTable("children").execute();',
        }),
      );
      assert.deepEqual(result.findings, []);
    });
  }

  for (const operator of ["=", "!=", "<", "<=", ">", ">=", "is", "is not"]) {
    await t.test(`index operator ${operator}`, async (subtest) => {
      const result = await analyzeSource(
        subtest,
        migrationSource({
          upBody: `
            await db.schema
              .createIndex("users_active_idx")
              .on("users")
              .column("enabled")
              .where("enabled", "${operator}", null)
              .execute();
          `,
          downBody: 'await db.schema.dropIndex("users_active_idx").execute();',
        }),
      );
      assert.deepEqual(result.findings, []);
    });
  }
});

test("accepts every primitive position and an up-only helper", async (t) => {
  const result = await analyzeSource(
    t,
    migrationSource({
      declarations: `
        async function shared(db: Kysely<unknown>): Promise<void> {
          await db.schema
            .createIndex("users_name_idx")
            .on("users")
            .column("name")
            .execute();
        }
      `,
      upBody: `
        await db.schema
          .createTable("users")
          .addColumn("text_default", "text", (column) => column.defaultTo("ready"))
          .addColumn("number_default", "integer", (column) => column.defaultTo(1))
          .addColumn("false_default", "boolean", (column) => column.defaultTo(false))
          .execute();
        await db.schema.createIndex("users_rank_idx").on("users").column("rank").where("rank", ">", 0).execute();
        await db.schema.createIndex("users_state_idx").on("users").column("state").where("state", "=", "ready").execute();
        await db.schema.createIndex("users_enabled_idx").on("users").column("enabled").where("enabled", "=", false).execute();
        await shared(db);
      `,
      downBody: `
        await db.schema.dropIndex("users_enabled_idx").execute();
        await db.schema.dropIndex("users_state_idx").execute();
        await db.schema.dropIndex("users_rank_idx").execute();
        await db.schema.dropTable("users").execute();
      `,
    }),
  );

  assert.deepEqual(result.findings, []);
});

test("rejects every noncanonical runtime import and re-export shape", async (t) => {
  const cases = [
    [
      "default sql import",
      'import sql from "kysely";',
      "MIGRATION_IMPORT_SHAPE",
    ],
    [
      "namespace sql import",
      'import * as sql from "kysely";',
      "MIGRATION_IMPORT_SHAPE",
    ],
    [
      "mixed sql import",
      'import sqlDefault, { sql } from "kysely";',
      "MIGRATION_IMPORT_SHAPE",
    ],
    [
      "aliased sql import",
      'import { sql as query } from "kysely";',
      "MIGRATION_IMPORT_SHAPE",
    ],
    [
      "extra runtime import",
      'import { sql, Kysely } from "kysely";',
      "MIGRATION_IMPORT_SHAPE",
    ],
    ["side effect import", 'import "kysely";', "MIGRATION_IMPORT_SHAPE"],
    [
      "local runtime import",
      'import { helper } from "./helper.js";',
      "MIGRATION_IMPORT_SHAPE",
    ],
    [
      "other runtime package",
      'import { join } from "node:path";',
      "MIGRATION_IMPORT_SHAPE",
    ],
    [
      "inline type-only import",
      'import { type Kysely } from "kysely";',
      "MIGRATION_IMPORT_SHAPE",
    ],
    [
      "inline type mixed with sql",
      'import { sql, type Kysely } from "kysely";',
      "MIGRATION_IMPORT_SHAPE",
    ],
    [
      "duplicate sql import",
      'import { sql } from "kysely"; import { sql } from "kysely";',
      "MIGRATION_IMPORT_SHAPE",
    ],
    [
      "runtime re-export",
      'export { sql } from "kysely";',
      "MIGRATION_EXPORT_SHAPE",
    ],
    [
      "type re-export",
      'export type { Kysely } from "kysely";',
      "MIGRATION_EXPORT_SHAPE",
    ],
  ];

  for (const [name, imports, code] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({ imports: `${imports}\n${typeImport}` }),
        code,
      ),
    );
  }
});

test("rejects executable and object-valued top-level declarations", async (t) => {
  const cases = [
    ["literal constant", "const value = 1;"],
    ["enum", "enum State { Active }"],
    ["class", "class MigrationClass {}"],
    ["namespace", "namespace MigrationNamespace { export type Id = string; }"],
    ["getter", "const value = { get secret() { return 1; } };"],
    ["setter", "const value = { set secret(next) {} };"],
    ["method definition", "const value = { migrate() {} };"],
    ["computed key", 'const key = "x"; const value = { [key]: 1 };'],
    ["object spread", "const value = { ...other };"],
    ["function initializer", "const helper = async () => {};"],
    ["top-level await", "await Promise.resolve();"],
    ["executable throw", 'throw new Error("must not execute");'],
    ["static block", "class MigrationClass { static {} }"],
    ["exported type alias", "export type MigrationId = string;"],
    ["exported interface", "export interface MigrationMarker {}"],
  ];

  for (const [name, declarations] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({ declarations }),
        "MIGRATION_TOP_LEVEL_SHAPE",
      ),
    );
  }
});

test("rejects aliases, shadowing, deceptive bindings, and invalid function shapes", async (t) => {
  const cases = [
    [
      "db alias",
      'const database = db; await database.schema.createTable("x").addColumn("id", "uuid").execute();',
    ],
    [
      "schema alias",
      'const schema = db.schema; await schema.createTable("x").addColumn("id", "uuid").execute();',
    ],
    [
      "builder alias",
      'const builder = db.schema.createTable("x"); await builder.addColumn("id", "uuid").execute();',
    ],
    [
      "shadowed db callback",
      'await db.schema.createTable("x").addColumn("id", "uuid", (db) => db.notNull()).execute();',
    ],
    [
      "shadowed sql callback",
      'await db.schema.createTable("x").addColumn("id", "uuid", (sql) => sql.defaultTo(sql`now()`)).execute();',
    ],
    [
      "other receiver",
      'await db.schema.createTable("x").addColumn("id", "uuid", (column) => other.notNull()).execute();',
    ],
    [
      "fake root createTable",
      'await createTable("x").addColumn("id", "uuid").execute();',
    ],
    ["fake execute", "await execute();"],
    [
      "same spelling property",
      'await fake.createTable("x").addColumn("id", "uuid").execute();',
    ],
    ["body assignment", "db = other;"],
    [
      "nested closure",
      'async function nested(db) { await db.schema.dropTable("x").execute(); } await nested(db);',
    ],
    ["constructor", "await new Promise((resolve) => resolve());"],
    ["Promise combinator", "await Promise.all([]);"],
    [
      "optional chain",
      'await db?.schema.createTable("x").addColumn("id", "uuid").execute();',
    ],
    [
      "computed access",
      'await db["schema"].createTable("x").addColumn("id", "uuid").execute();',
    ],
  ];

  for (const [name, upBody] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({ imports: sqlImports, upBody }),
        "MIGRATION_BINDING_SHAPE",
      ),
    );
  }

  for (const [name, source] of [
    ["default parameter", migrationSource({ upParameter: "db = fallback" })],
    ["rest parameter", migrationSource({ upParameter: "...db" })],
    ["destructured parameter", migrationSource({ upParameter: "{ schema }" })],
    [
      "generator",
      `${typeImport}\nexport async function* up(db) { yield db; }\nexport async function down(db) { ${safeDrop} }`,
    ],
    [
      "recursive helper",
      migrationSource({
        declarations: "async function helper(db) { await helper(db); }",
        upBody: "await helper(db);",
      }),
    ],
    [
      "mutual recursion",
      migrationSource({
        declarations:
          "async function first(db) { await second(db); } async function second(db) { await first(db); }",
        upBody: "await first(db);",
      }),
    ],
  ]) {
    await t.test(name, (subtest) =>
      assertRejected(subtest, source, "MIGRATION_BINDING_SHAPE"),
    );
  }
});

test("rejects malformed table and index builder chains", async (t) => {
  const cases = [
    ["missing table column", 'await db.schema.createTable("x").execute();'],
    [
      "createTable arity",
      'await db.schema.createTable("x", "y").addColumn("id", "uuid").execute();',
    ],
    [
      "addColumn arity",
      'await db.schema.createTable("x").addColumn("id").execute();',
    ],
    [
      "execute arguments",
      'await db.schema.createTable("x").addColumn("id", "uuid").execute("now");',
    ],
    [
      "execute before end",
      'await db.schema.createTable("x").addColumn("id", "uuid").execute().addColumn("late", "text");',
    ],
    [
      "nonliteral table",
      'await db.schema.createTable(dbName).addColumn("id", "uuid").execute();',
    ],
    [
      "empty constraint array",
      'await db.schema.createTable("x").addColumn("id", "uuid").addPrimaryKeyConstraint("pk", []).execute();',
    ],
    [
      "holey constraint array",
      'await db.schema.createTable("x").addColumn("id", "uuid").addUniqueConstraint("uq", [,"id"]).execute();',
    ],
    [
      "spread constraint array",
      'await db.schema.createTable("x").addColumn("id", "uuid").addUniqueConstraint("uq", [...columns]).execute();',
    ],
    [
      "foreign key unequal arrays",
      'await db.schema.createTable("x").addColumn("a", "uuid").addForeignKeyConstraint("fk", ["a", "b"], "y", ["id"]).execute();',
    ],
    [
      "forbidden constraint callback",
      'await db.schema.createTable("x").addColumn("id", "uuid").addUniqueConstraint("uq", ["id"], (constraint) => constraint).execute();',
    ],
    [
      "block column callback",
      'await db.schema.createTable("x").addColumn("id", "uuid", (column) => { return column.notNull(); }).execute();',
    ],
    [
      "factory column callback",
      'await db.schema.createTable("x").addColumn("id", "uuid", makeCallback()).execute();',
    ],
    [
      "nonbinding callback receiver",
      'await db.schema.createTable("x").addColumn("id", "uuid", (column) => fake.notNull()).execute();',
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "onDelete before references",
      'await db.schema.createTable("x").addColumn("id", "uuid", (column) => column.onDelete("cascade").references("y.id")).execute();',
    ],
    [
      "duplicate column method",
      'await db.schema.createTable("x").addColumn("id", "uuid", (column) => column.notNull().notNull()).execute();',
    ],
    [
      "invalid action",
      'await db.schema.createTable("x").addColumn("id", "uuid", (column) => column.references("y.id").onDelete("destroy")).execute();',
    ],
    [
      "index missing on",
      'await db.schema.createIndex("idx").column("id").execute();',
    ],
    [
      "index column before on",
      'await db.schema.createIndex("idx").column("id").on("x").execute();',
    ],
    [
      "index missing column",
      'await db.schema.createIndex("idx").on("x").execute();',
    ],
    [
      "empty index columns",
      'await db.schema.createIndex("idx").on("x").columns([]).execute();',
    ],
    [
      "holey index columns",
      'await db.schema.createIndex("idx").on("x").columns([,"id"]).execute();',
    ],
    [
      "spread index columns",
      'await db.schema.createIndex("idx").on("x").columns([...columns]).execute();',
    ],
    [
      "mixed column and columns",
      'await db.schema.createIndex("idx").on("x").column("id").columns(["name"]).execute();',
    ],
    [
      "duplicate unique",
      'await db.schema.createIndex("idx").unique().unique().on("x").column("id").execute();',
    ],
    [
      "duplicate on",
      'await db.schema.createIndex("idx").on("x").on("y").column("id").execute();',
    ],
    [
      "duplicate columns",
      'await db.schema.createIndex("idx").on("x").columns(["id"]).columns(["name"]).execute();',
    ],
    [
      "duplicate where",
      'await db.schema.createIndex("idx").on("x").column("id").where("id", "=", 1).where("id", "=", 2).execute();',
    ],
    [
      "where before column",
      'await db.schema.createIndex("idx").on("x").where("id", "=", 1).column("id").execute();',
    ],
    [
      "index callback",
      'await db.schema.createIndex("idx").on("x").column((builder) => builder.ref("id")).execute();',
    ],
    [
      "expression column",
      'await db.schema.createIndex("idx").on("x").column(sql`lower(name)`).execute();',
    ],
    [
      "invalid operator",
      'await db.schema.createIndex("idx").on("x").column("id").where("id", "like", "x").execute();',
    ],
  ];

  for (const [
    name,
    upBody,
    expectedCode = "MIGRATION_UP_OPAQUE_CALL",
  ] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({ imports: sqlImports, upBody }),
        expectedCode,
      ),
    );
  }
});

test("accepts only the exact erased partial-index type widening", async (t) => {
  const positive = migrationSource({
    upBody: `
      await db.schema
        .createIndex("devices_user_active_idx")
        .on("devices")
        .column<"user_id" | "revoked_at">("user_id")
        .where("revoked_at", "is", null)
        .execute();
    `,
    downBody: 'await db.schema.dropIndex("devices_user_active_idx").execute();',
  });
  assert.deepEqual((await analyzeSource(t, positive)).findings, []);

  const cases = [
    ["missing where", '.column<"user_id" | "revoked_at">("user_id")'],
    [
      "reversed members",
      '.column<"revoked_at" | "user_id">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "duplicate members",
      '.column<"user_id" | "user\\u005fid">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "one member",
      '.column<"user_id">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "three members",
      '.column<"user_id" | "revoked_at" | "other">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "parenthesized union",
      '.column<("user_id" | "revoked_at")>("user_id").where("revoked_at", "is", null)',
    ],
    [
      "nested union",
      '.column<"user_id" | ("revoked_at" | "other")>("user_id").where("revoked_at", "is", null)',
    ],
    [
      "intersection",
      '.column<"user_id" & "revoked_at">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "type reference",
      '.column<IndexColumns>("user_id").where("revoked_at", "is", null)',
    ],
    [
      "template literal type",
      '.column<`user_id` | "revoked_at">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "conditional type",
      '.column<(true extends true ? "user_id" : "x") | "revoked_at">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "indexed type",
      '.column<Columns["user_id"] | "revoked_at">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "keyof type",
      '.column<keyof Columns | "revoked_at">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "type query",
      '.column<typeof runtimeColumn | "revoked_at">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "keyword type",
      '.column<string | "revoked_at">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "non-string member",
      '.column<1 | "revoked_at">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "runtime mismatch",
      '.column<"other" | "revoked_at">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "predicate mismatch",
      '.column<"user_id" | "other">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "multiple column calls",
      '.column<"user_id" | "revoked_at">("user_id").column("name").where("revoked_at", "is", null)',
    ],
    [
      "mixed columns",
      '.column<"user_id" | "revoked_at">("user_id").columns(["name"]).where("revoked_at", "is", null)',
    ],
    [
      "duplicate where",
      '.column<"user_id" | "revoked_at">("user_id").where("revoked_at", "is", null).where("revoked_at", "is", null)',
    ],
    [
      "generic where",
      '.column<"user_id" | "revoked_at">("user_id").where<"revoked_at">("revoked_at", "is", null)',
    ],
  ];

  for (const [name, middle] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({
          declarations:
            'type IndexColumns = "user_id" | "revoked_at"; interface Columns { user_id: "user_id"; } declare const runtimeColumn: "user_id";',
          upBody: `await db.schema.createIndex("idx").on("devices")${middle}.execute();`,
          downBody: 'await db.schema.dropIndex("idx").execute();',
        }),
        "MIGRATION_UP_OPAQUE_CALL",
      ),
    );
  }

  for (const [name, upBody] of [
    [
      "generic createIndex",
      'await db.schema.createIndex<"idx">("idx").on("x").column("id").execute();',
    ],
    [
      "generic on",
      'await db.schema.createIndex("idx").on<"x">("x").column("id").execute();',
    ],
    [
      "generic columns",
      'await db.schema.createIndex("idx").on("x").columns<"id">(["id"]).execute();',
    ],
    [
      "generic execute",
      'await db.schema.createIndex("idx").on("x").column("id").execute<void>();',
    ],
    [
      "generic table builder",
      'await db.schema.createTable<"x">("x").addColumn("id", "uuid").execute();',
    ],
    [
      "generic callback",
      'await db.schema.createTable("x").addColumn("id", "uuid", (column) => column.notNull<void>()).execute();',
    ],
  ]) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({ upBody }),
        "MIGRATION_UP_OPAQUE_CALL",
      ),
    );
  }
});

test("rejects every explicit and generated opaque up method", async (t) => {
  const rootMethods = ["updateTable", "replaceInto", "mergeInto"];
  for (const method of rootMethods) {
    await t.test(method, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({ upBody: `await db.${method}("x").execute();` }),
        "MIGRATION_UP_OPAQUE_CALL",
      ),
    );
  }

  for (const method of [
    "dropNotNull",
    "setSchema",
    "renameValue",
    "orReplace",
    "alterTable",
    "dropColumn",
    "renameColumn",
    "modifyColumn",
    "withPlugin",
    "$call",
    "dynamic",
    "totallyUnknownMethod",
  ]) {
    await t.test(method, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({
          upBody: `await db.schema.createTable("x").addColumn("id", "uuid").${method}().execute();`,
        }),
        "MIGRATION_UP_OPAQUE_CALL",
      ),
    );
  }
});

test("rejects unbounded, interpolated, deceptive, and executable SQL", async (t) => {
  const cases = [
    ["interpolation", "sql`score > ${db}`"],
    ["concatenation", 'sql`score > 0` + ""'],
    ["raw", 'sql.raw("score > 0")'],
    ["ref", 'sql.ref("score")'],
    ["lit", "sql.lit(1)"],
    ["alias", "query`score > 0`"],
  ];
  for (const [name, expression] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({
          imports:
            name === "alias"
              ? 'import { sql as query } from "kysely";\n' + typeImport
              : sqlImports,
          upBody: `await db.schema.createTable("x").addColumn("score", "integer", (column) => column.check(${expression})).execute();`,
        }),
        "MIGRATION_SQL_SHAPE",
      ),
    );
  }

  for (const sqlText of [
    "value; other",
    "value -- comment",
    "value /* comment */",
    "value $tag$ body $tag$",
    "ALTER value",
    "CALL value",
    "COPY value",
    "CREATE value",
    "DELETE value",
    "DO value",
    "DROP value",
    "EXECUTE value",
    "GRANT value",
    "INSERT value",
    "LOCK value",
    "REINDEX value",
    "RENAME value",
    "REVOKE value",
    "SET value",
    "RESET value",
    "TRUNCATE value",
    "UPDATE value",
    "VACUUM value",
  ]) {
    await t.test(sqlText, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({
          imports: sqlImports,
          upBody: `await db.schema.createTable("x").addColumn("score", "integer", (column) => column.check(sql\`${sqlText}\`)).execute();`,
        }),
        "MIGRATION_SQL_SHAPE",
      ),
    );
  }

  await t.test("standalone raw SQL", (subtest) =>
    assertRejected(
      subtest,
      migrationSource({
        imports: sqlImports,
        upBody: "await sql`select 1`.execute(db);",
      }),
      "MIGRATION_BINDING_SHAPE",
    ),
  );
});

test("rejects destructive and opaque down code outside the exact rollback table", async (t) => {
  const cases = [
    ["ifExists", 'await db.schema.dropTable("x").ifExists().execute();'],
    ["cascade", 'await db.schema.dropTable("x").cascade().execute();'],
    ["alternate drop", 'await db.schema.dropType("x").execute();'],
    ["dynamic name", "await db.schema.dropTable(tableName).execute();"],
    ["unknown method", 'await db.schema.dropTable("x").unknown().execute();'],
    ["raw SQL", "await sql`drop table x`.execute(db);"],
    [
      "create in down",
      'await db.schema.createTable("x").addColumn("id", "uuid").execute();',
    ],
    ["delete query", 'await db.deleteFrom("x").execute();'],
  ];

  for (const [name, downBody] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({ imports: sqlImports, downBody }),
        "MIGRATION_DOWN_OPAQUE_CALL",
      ),
    );
  }

  await t.test("opaque down-only helper", (subtest) =>
    assertRejected(
      subtest,
      migrationSource({
        declarations:
          'async function rollback(db) { await db.schema.dropTable("x").ifExists().execute(); }',
        downBody: "await rollback(db);",
      }),
      "MIGRATION_DOWN_OPAQUE_CALL",
    ),
  );
});

test("rejects the remaining lexical binding and function-body mutations", async (t) => {
  const bodyCases = [
    ["bind", "await helper.bind(null, db)();"],
    ["call", "await helper.call(null, db);"],
    ["apply", "await helper.apply(null, [db]);"],
    ["function value", "const callable = helper; await callable(db);"],
    ["object method", "const object = { helper }; await object.helper(db);"],
    ["unresolved invocation", "await missing(db);"],
    ["lifecycle as helper", "await down(db);"],
    ["if", "if (db) { await helper(db); }"],
    ["switch", "switch (db) { default: break; }"],
    ["for", "for (;;) { break; }"],
    ["for of", "for (const value of []) { await helper(db); }"],
    ["while", "while (false) { await helper(db); }"],
    ["do while", "do { break; } while (false);"],
    ["try catch", "try { await helper(db); } catch {}"],
    ["throw", 'throw new Error("blocked");'],
    ["new", "await new Promise((resolve) => resolve());"],
    ["this", "await this.helper(db);"],
    ["return value", "return db;"],
    ["local function", "async function nested(db) { await helper(db); }"],
    ["local class", "class Nested {}"],
    ["local assignment", "db.schema = other;"],
    ["postfix mutation", "counter++;"],
    ["awaited conditional", "await (condition ? helper(db) : other(db));"],
  ];

  for (const [name, upBody] of bodyCases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({
          declarations: "async function helper(db) { return; }",
          upBody,
        }),
        "MIGRATION_BINDING_SHAPE",
      ),
    );
  }

  for (const [name, upBody] of [
    ["duplicate bare return", "return; return;"],
    ["nonterminal bare return", `return; ${safeCreate}`],
  ]) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({ upBody }),
        "MIGRATION_BINDING_SHAPE",
      ),
    );
  }

  await t.test("runtime imported callable", (subtest) =>
    assertRejected(
      subtest,
      migrationSource({
        imports: `${typeImport}\nimport { helper } from "migration-helper";`,
        upBody: "await helper(db);",
      }),
      "MIGRATION_IMPORT_SHAPE",
    ),
  );

  await t.test("duplicate helper declaration", (subtest) =>
    assertRejected(
      subtest,
      migrationSource({
        declarations:
          "async function helper(db) { return; } async function helper(db) { return; }",
        upBody: "await helper(db);",
      }),
      "MIGRATION_BINDING_SHAPE",
    ),
  );

  await t.test("helper shadowed by lifecycle db parameter", (subtest) =>
    assertRejected(
      subtest,
      migrationSource({
        declarations: `async function db(db) { ${safeCreate} }`,
        upBody: "await db(db);",
      }),
      "MIGRATION_BINDING_SHAPE",
    ),
  );

  for (const [name, source, expectedCode = "MIGRATION_BINDING_SHAPE"] of [
    [
      "missing down lifecycle",
      `${typeImport}\nexport async function up(db) { ${safeCreate} }`,
      "MIGRATION_EXPORT_SHAPE",
    ],
    [
      "duplicate up lifecycle",
      `${typeImport}\nexport async function up(db) { ${safeCreate} }\nexport async function up(db) { ${safeCreate} }\nexport async function down(db) { ${safeDrop} }`,
    ],
    [
      "default-exported up lifecycle",
      `${typeImport}\nexport default async function up(db) { ${safeCreate} }\nexport async function down(db) { ${safeDrop} }`,
    ],
    [
      "exported helper",
      migrationSource({
        declarations: "export async function helper(db) { return; }",
        upBody: "await helper(db);",
      }),
    ],
    [
      "helper overload",
      migrationSource({
        declarations:
          "async function helper(db: Kysely<unknown>): Promise<void>; async function helper(db: Kysely<unknown>): Promise<void> { return; }",
        upBody: "await helper(db);",
      }),
    ],
  ]) {
    await t.test(name, (subtest) =>
      assertRejected(subtest, source, expectedCode),
    );
  }
});

test("rejects every forbidden inline callback shape and position", async (t) => {
  const callbackCases = [
    [
      "async callback",
      "async (column) => column.notNull()",
      "MIGRATION_UP_OPAQUE_CALL",
    ],
    [
      "no callback parameter",
      "() => column.notNull()",
      "MIGRATION_UP_OPAQUE_CALL",
    ],
    [
      "two callback parameters",
      "(column, other) => column.notNull()",
      "MIGRATION_UP_OPAQUE_CALL",
    ],
    [
      "default callback parameter",
      "(column = fallback) => column.notNull()",
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "rest callback parameter",
      "(...column) => column.notNull()",
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "destructured callback parameter",
      "({ column }) => column.notNull()",
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "optional callback parameter",
      "(column?: unknown) => column.notNull()",
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "db callback parameter",
      "(db) => db.notNull()",
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "sql callback parameter",
      "(sql) => sql.notNull()",
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "helper callback parameter",
      "(helper) => helper.notNull()",
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "function callback",
      "function (column) { return column.notNull(); }",
      "MIGRATION_UP_OPAQUE_CALL",
    ],
    [
      "free callback call",
      "(column) => decorate(column)",
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "callback receiver alias",
      "(column) => alias.notNull()",
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "callback optional call",
      "(column) => column?.notNull()",
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "callback computed call",
      '(column) => column["notNull"]()',
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "generic callback arrow",
      "<T>(column: T) => column.notNull()",
      "MIGRATION_UP_OPAQUE_CALL",
    ],
  ];

  for (const [name, callback, expectedCode] of callbackCases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({
          declarations: "async function helper(db) { return; }",
          upBody: `await db.schema.createTable("x").addColumn("id", "uuid", ${callback}).execute();`,
        }),
        expectedCode,
      ),
    );
  }

  for (const [name, upBody] of [
    [
      "primary key callback",
      'await db.schema.createTable("x").addColumn("id", "uuid").addPrimaryKeyConstraint("pk", ["id"], (constraint) => constraint).execute();',
    ],
    [
      "check callback",
      'await db.schema.createTable("x").addColumn("id", "uuid").addCheckConstraint("check", sql`true`, (constraint) => constraint).execute();',
    ],
    [
      "index on callback",
      'await db.schema.createIndex("idx").on((builder) => builder.table("x")).column("id").execute();',
    ],
    [
      "index predicate callback",
      'await db.schema.createIndex("idx").on("x").column("id").where((builder) => builder.ref("id"), "=", 1).execute();',
    ],
  ]) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({ imports: sqlImports, upBody }),
        "MIGRATION_UP_OPAQUE_CALL",
      ),
    );
  }

  for (const [name, callback, expectedCode] of [
    [
      "foreign block callback",
      '(foreignKey) => { return foreignKey.onDelete("cascade"); }',
      "MIGRATION_UP_OPAQUE_CALL",
    ],
    ["foreign factory callback", "makeCallback()", "MIGRATION_UP_OPAQUE_CALL"],
    [
      "foreign nonbinding receiver",
      '(foreignKey) => fake.onDelete("cascade")',
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "foreign free call",
      "(foreignKey) => decorate(foreignKey)",
      "MIGRATION_BINDING_SHAPE",
    ],
  ]) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({
          upBody: `await db.schema.createTable("x").addColumn("owner_id", "uuid").addForeignKeyConstraint("fk", ["owner_id"], "owners", ["id"], ${callback}).execute();`,
        }),
        expectedCode,
      ),
    );
  }
});

test("rejects table state-order and literal-domain mutations", async (t) => {
  const cases = [
    [
      "column after primary key",
      'await db.schema.createTable("x").addColumn("id", "uuid").addPrimaryKeyConstraint("pk", ["id"]).addColumn("name", "text").execute();',
    ],
    [
      "primary key after unique",
      'await db.schema.createTable("x").addColumn("id", "uuid").addUniqueConstraint("uq", ["id"]).addPrimaryKeyConstraint("pk", ["id"]).execute();',
    ],
    [
      "unique after foreign key",
      'await db.schema.createTable("x").addColumn("id", "uuid").addForeignKeyConstraint("fk", ["id"], "parent", ["id"]).addUniqueConstraint("uq", ["id"]).execute();',
    ],
    [
      "foreign key after check",
      'await db.schema.createTable("x").addColumn("id", "uuid").addCheckConstraint("ck", sql`true`).addForeignKeyConstraint("fk", ["id"], "parent", ["id"]).execute();',
    ],
    [
      "primary key wrong arity",
      'await db.schema.createTable("x").addColumn("id", "uuid").addPrimaryKeyConstraint("pk", ["id"], true).execute();',
    ],
    [
      "foreign callback wrong position",
      'await db.schema.createTable("x").addColumn("id", "uuid").addForeignKeyConstraint("fk", ["id"], "parent", (foreignKey) => foreignKey.onDelete("cascade"), ["id"]).execute();',
    ],
    [
      "undefined default",
      'await db.schema.createTable("x").addColumn("id", "integer", (column) => column.defaultTo(undefined)).execute();',
    ],
    [
      "NaN default",
      'await db.schema.createTable("x").addColumn("id", "integer", (column) => column.defaultTo(NaN)).execute();',
    ],
    [
      "Infinity default",
      'await db.schema.createTable("x").addColumn("id", "integer", (column) => column.defaultTo(Infinity)).execute();',
    ],
    [
      "positive unary default",
      'await db.schema.createTable("x").addColumn("id", "integer", (column) => column.defaultTo(+1)).execute();',
    ],
    [
      "object default",
      'await db.schema.createTable("x").addColumn("id", "jsonb", (column) => column.defaultTo({})).execute();',
    ],
    [
      "negative index primitive",
      'await db.schema.createIndex("idx").on("x").column("id").where("id", ">", -1).execute();',
    ],
    [
      "undefined index primitive",
      'await db.schema.createIndex("idx").on("x").column("id").where("id", "=", undefined).execute();',
    ],
    [
      "unique after on",
      'await db.schema.createIndex("idx").on("x").unique().column("id").execute();',
    ],
    [
      "index execute before end",
      'await db.schema.createIndex("idx").on("x").column("id").execute().where("id", "=", 1);',
    ],
  ];

  for (const [name, upBody] of cases) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({ imports: sqlImports, upBody }),
        "MIGRATION_UP_OPAQUE_CALL",
      ),
    );
  }
});

test("rejects the complete erased-type-argument mutation tail", async (t) => {
  const indexMutations = [
    [
      "zero type arguments",
      '.column<>("user_id").where("revoked_at", "is", null)',
    ],
    [
      "extra type arguments",
      '.column<"user_id" | "revoked_at", "extra">("user_id").where("revoked_at", "is", null)',
    ],
    [
      "escape-equivalent duplicate",
      '.column<"user_id" | "user\\u005fid">("user_id").where("user_id", "is", null)',
    ],
    [
      "earlier where",
      '.where("revoked_at", "is", null).column<"user_id" | "revoked_at">("user_id")',
    ],
  ];

  for (const [name, middle] of indexMutations) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({
          upBody: `await db.schema.createIndex("idx").on("users")${middle}.execute();`,
        }),
        "MIGRATION_UP_OPAQUE_CALL",
      ),
    );
  }

  for (const [
    name,
    upBody,
    downBody = safeDrop,
    declarations = "",
    expectedCode = "MIGRATION_UP_OPAQUE_CALL",
  ] of [
    [
      "generic addColumn",
      'await db.schema.createTable("x").addColumn<"id">("id", "uuid").execute();',
    ],
    [
      "generic callback arrow",
      'await db.schema.createTable("x").addColumn("id", "uuid", <T>(column: T) => column.notNull()).execute();',
    ],
    [
      "empty generic callback arrow",
      'await db.schema.createTable("x").addColumn("id", "uuid", <>(column) => column.notNull()).execute();',
      safeDrop,
      "",
      "MIGRATION_PARSE",
    ],
    [
      "generic helper",
      "await helper<void>(db);",
      safeDrop,
      "async function helper(db) { return; }",
      "MIGRATION_BINDING_SHAPE",
    ],
    [
      "generic rollback root",
      safeCreate,
      'await db.schema.dropTable<"x">("x").execute();',
      "",
      "MIGRATION_DOWN_OPAQUE_CALL",
    ],
    [
      "generic rollback execute",
      safeCreate,
      'await db.schema.dropTable("x").execute<void>();',
      "",
      "MIGRATION_DOWN_OPAQUE_CALL",
    ],
  ]) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({
          declarations,
          upBody,
          downBody,
        }),
        expectedCode,
      ),
    );
  }

  for (const [name, source] of [
    [
      "empty generic up declaration",
      `${typeImport}\nexport async function up<>(db) { ${safeCreate} }\nexport async function down(db) { ${safeDrop} }`,
    ],
    [
      "empty generic helper declaration",
      migrationSource({
        declarations: "async function helper<>(db) { return; }",
        upBody: "await helper(db);",
      }),
    ],
  ]) {
    await t.test(name, (subtest) =>
      assertRejected(subtest, source, "MIGRATION_BINDING_SHAPE"),
    );
  }
});

test("rejects deceptive SQL source spellings without leaking SQL text", async (t) => {
  for (const [name, sqlText] of [
    ["lowercase forbidden token", "drop value"],
    ["mixed-case forbidden token", "DrOp value"],
    ["escaped forbidden token", "\\u0044ROP value"],
    ["escaped semicolon", "value\\u003b other"],
    ["untagged template", "value"],
  ]) {
    await t.test(name, async (subtest) => {
      const expression =
        name === "untagged template" ? "`value`" : `sql\`${sqlText}\``;
      const result = await analyzeSource(
        subtest,
        migrationSource({
          imports: sqlImports,
          upBody: `await db.schema.createTable("x").addColumn("score", "integer", (column) => column.check(${expression})).execute();`,
        }),
      );
      assertFindingShape(result);
      assert.ok(
        result.findings.some(({ code }) => code === "MIGRATION_SQL_SHAPE"),
      );
      assert.equal(JSON.stringify(result).includes(sqlText), false);
    });
  }

  for (const [name, sqlExpression] of [
    ["generic SQL tag", "sql<string>`value`"],
    ["empty generic SQL tag", "sql<>`value`"],
  ]) {
    await t.test(name, (subtest) =>
      assertRejected(
        subtest,
        migrationSource({
          imports: sqlImports,
          upBody: `await db.schema.createTable("x").addColumn("score", "integer", (column) => column.check(${sqlExpression})).execute();`,
        }),
        "MIGRATION_SQL_SHAPE",
      ),
    );
  }
});

test("path handling is contained, symlink-safe, regular-file-only, and sorted", async (t) => {
  const rootPath = await mkdtemp(
    path.join(os.tmpdir(), "crewroll-b2b-ii-a-paths-"),
  );
  t.after(async () => rm(rootPath, { force: true, recursive: true }));
  const migrationRoot = path.join(
    rootPath,
    "services/control-plane/src/db/migrations",
  );
  await mkdir(migrationRoot, { recursive: true });

  const secondPath = "services/control-plane/src/db/migrations/002_second.ts";
  await writeFile(
    path.join(rootPath, migrationPath),
    migrationSource({ declarations: "const first = 1;" }),
    "utf8",
  );
  await writeFile(
    path.join(rootPath, secondPath),
    migrationSource({ declarations: "const second = 2;" }),
    "utf8",
  );
  const sorted = await analyzeMigrationModules({
    rootPath,
    migrationFiles: [secondPath, migrationPath],
  });
  assert.equal(sorted.migrationCount, 2);
  assert.ok(Object.isFrozen(sorted));
  assert.ok(Object.isFrozen(sorted.findings));
  assert.deepEqual(
    sorted.findings.map(({ path: findingPath }) => findingPath),
    [migrationPath, secondPath],
  );

  const invalidPathResult = await analyzeMigrationModules({
    rootPath,
    migrationFiles: ["services/control-plane/src/db/migrations/../outside.ts"],
  });
  assert.ok(
    invalidPathResult.findings.some(
      ({ code }) => code === "MIGRATION_TOPOLOGY",
    ),
  );
  assert.ok(Object.isFrozen(invalidPathResult));
  assert.ok(Object.isFrozen(invalidPathResult.findings));
  assert.ok(Object.isFrozen(invalidPathResult.findings[0]));

  const traversalResult = await analyzeMigrationModules({
    rootPath,
    migrationFiles: ["../../outside.ts"],
  });
  assert.deepEqual(traversalResult.findings, [
    {
      code: "MIGRATION_TOPOLOGY",
      path: "services/control-plane/src/db/migrations",
      line: 1,
      column: 1,
    },
  ]);

  const directoryPath =
    "services/control-plane/src/db/migrations/003_directory.ts";
  await mkdir(path.join(rootPath, directoryPath));
  const directoryResult = await analyzeMigrationModules({
    rootPath,
    migrationFiles: [directoryPath],
  });
  assert.ok(
    directoryResult.findings.some(({ code }) => code === "MIGRATION_TOPOLOGY"),
  );
  assert.ok(Object.isFrozen(directoryResult.findings[0]));

  const linkPath = "services/control-plane/src/db/migrations/004_link.ts";
  await symlink(
    path.join(rootPath, migrationPath),
    path.join(rootPath, linkPath),
  );
  const linkResult = await analyzeMigrationModules({
    rootPath,
    migrationFiles: [linkPath],
  });
  assert.ok(
    linkResult.findings.some(({ code }) => code === "MIGRATION_SYMLINK"),
  );
  assert.ok(Object.isFrozen(linkResult.findings[0]));

  const linkedRootPath = await mkdtemp(
    path.join(os.tmpdir(), "crewroll-b2b-ii-a-directory-link-"),
  );
  t.after(async () => rm(linkedRootPath, { force: true, recursive: true }));
  const realMigrationRoot = path.join(linkedRootPath, "real-migrations");
  await mkdir(realMigrationRoot);
  await writeFile(
    path.join(realMigrationRoot, "001_initial.ts"),
    migrationSource(),
    "utf8",
  );
  const linkedDbRoot = path.join(
    linkedRootPath,
    "services/control-plane/src/db",
  );
  await mkdir(linkedDbRoot, { recursive: true });
  await symlink(realMigrationRoot, path.join(linkedDbRoot, "migrations"));
  const directoryLinkResult = await analyzeMigrationModules({
    rootPath: linkedRootPath,
    migrationFiles: [migrationPath],
  });
  assert.deepEqual(directoryLinkResult.findings, [
    {
      code: "MIGRATION_SYMLINK",
      path: migrationPath,
      line: 1,
      column: 1,
    },
  ]);
  assert.ok(Object.isFrozen(directoryLinkResult.findings[0]));
});

test("parsing is static, deterministic, frozen, and never evaluates target modules", async (t) => {
  const marker = "__crewrollMigrationPolicyMustNotExecute";
  delete globalThis[marker];
  t.after(() => delete globalThis[marker]);

  const result = await analyzeSource(
    t,
    migrationSource({
      declarations: `globalThis.${marker} = true;`,
    }),
  );
  assert.equal(globalThis[marker], undefined);
  assertFindingShape(result);
  assert.ok(
    result.findings.some(({ code }) => code === "MIGRATION_TOP_LEVEL_SHAPE"),
  );
  assert.equal(
    JSON.stringify(result.findings).includes("MustNotExecute"),
    false,
  );

  const parseResult = await analyzeSource(t, "export async function up( {");
  assertFindingShape(parseResult);
  assert.ok(
    parseResult.findings.some(({ code }) => code === "MIGRATION_PARSE"),
  );
});
