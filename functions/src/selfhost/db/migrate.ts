/**
 * Boot-time migration runner. drizzle-kit AUTHORS the SQL files under
 * functions/drizzle/ (from schema.ts); this runner APPLIES them through the
 * shim's SqlClient so the identical DDL path serves embedded PGlite (tests)
 * and real Postgres (compose CI, production LXC).
 *
 * Also handles two data moves, both idempotent:
 *  - adoption of a pre-Phase-1 spike database (a `docs` table with no
 *    tenant_id, created by the Phase-0 shim's inline DDL) into the
 *    migration-managed schema, and
 *  - the flatten backfill: rows whose collection has been flattened since
 *    the database was written move out of `docs` into their real table.
 */

import * as fs from "fs";
import * as path from "path";
import { FLATTENED } from "./collections";
import { getTenantId } from "./tenant";

type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface MigrationClient {
  /** Autocommit statement, NO tenant context — DDL and the ledger only. */
  query: QueryFn;
  /**
   * Run fn inside one transaction as the fibuki_app role with app.tenant_id
   * set (both SET LOCAL). tenantId null arms the role (and thus RLS) with no
   * tenant configured — the tests use it to prove the policies hold.
   */
  tx<T>(tenantId: string | null, fn: (q: QueryFn) => Promise<T>): Promise<T>;
}

/**
 * Locate functions/drizzle. Tests, the vite-node server and the compose CI
 * job all run with cwd=functions; walking upward also covers a repo-root
 * cwd. FIBUKI_MIGRATIONS_DIR overrides for exotic deploy layouts.
 */
export function resolveMigrationsDir(): string {
  const override = process.env.FIBUKI_MIGRATIONS_DIR;
  if (override) return override;
  let dir = process.cwd();
  for (;;) {
    for (const candidate of [path.join(dir, "drizzle"), path.join(dir, "functions", "drizzle")]) {
      if (fs.existsSync(path.join(candidate, "meta", "_journal.json"))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        "selfhost migrations: could not locate the drizzle/ migrations folder " +
          `walking up from ${process.cwd()} — set FIBUKI_MIGRATIONS_DIR`,
      );
    }
    dir = parent;
  }
}

/** True if the statement chunk contains anything besides comments/whitespace. */
function isExecutable(chunk: string): boolean {
  return chunk
    .split("\n")
    .some((line) => line.trim() !== "" && !line.trim().startsWith("--"));
}

async function tableExists(q: QueryFn, table: string): Promise<boolean> {
  const res = await q(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return res.rows.length > 0;
}

async function columnExists(q: QueryFn, table: string, column: string): Promise<boolean> {
  const res = await q(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return res.rows.length > 0;
}

export async function runMigrations(client: MigrationClient): Promise<void> {
  const { query } = client;

  // A Phase-0 spike database has `docs` but no ledger and no tenant_id:
  // step aside so migration 0000 can create the managed schema, then the
  // rows are re-imported under the default tenant below.
  const spike =
    (await tableExists(query, "docs")) &&
    !(await columnExists(query, "docs", "tenant_id")) &&
    !(await tableExists(query, "_migrations"));
  if (spike) {
    await query(`ALTER TABLE docs RENAME TO docs_spike_v0`);
  }

  // Ledger. Infrastructure, not tenant data — deliberately no tenant_id/RLS.
  await query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const applied = new Set(
    (await query(`SELECT name FROM _migrations`)).rows.map((r) => String(r.name)),
  );

  const dir = resolveMigrationsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const content = fs.readFileSync(path.join(dir, file), "utf8");
    for (const chunk of content.split(/-->\s*statement-breakpoint/)) {
      if (isExecutable(chunk)) await query(chunk);
    }
    await query(`INSERT INTO _migrations (name) VALUES ($1)`, [file]);
  }

  const tenantId = getTenantId();
  const hasSpikeRows = await tableExists(query, "docs_spike_v0");
  if (hasSpikeRows) await query(`GRANT SELECT ON docs_spike_v0 TO fibuki_app`);
  await client.tx(tenantId, async (q) => {
    // Bootstrap the (single) tenant. Runs inside tenant context because the
    // tenants table is itself under RLS.
    await q(
      `INSERT INTO tenants (id, name) VALUES ($1, 'default') ON CONFLICT (id) DO NOTHING`,
      [tenantId],
    );

    // Import a renamed spike table's rows under the default tenant. (The
    // spike table itself has no RLS policy, but the app role owns nothing —
    // it gets a one-off read grant in the adoption step above.)
    if (hasSpikeRows) {
      await q(
        `INSERT INTO docs (tenant_id, path, collection_path, id, data)
         SELECT $1, path, collection_path, id, data FROM docs_spike_v0
         ON CONFLICT (tenant_id, path) DO NOTHING`,
        [tenantId],
      );
    }

    // Flatten backfill: any rows still in `docs` for a collection that now
    // has a real table move over. No-op on a fresh or fully-migrated DB.
    // (Runs for the current tenant — with more tenants this iterates them.)
    for (const [collection, spec] of Object.entries(FLATTENED)) {
      await q(
        `INSERT INTO ${spec.table} (tenant_id, id, data)
         SELECT tenant_id, id, data FROM docs WHERE collection_path = $1
         ON CONFLICT (tenant_id, id) DO UPDATE SET data = EXCLUDED.data`,
        [collection],
      );
      await q(`DELETE FROM docs WHERE collection_path = $1`, [collection]);
    }
  });
  // DDL cleanup runs as the owner, outside the app-role transaction.
  if (hasSpikeRows) await query(`DROP TABLE docs_spike_v0`);
}
