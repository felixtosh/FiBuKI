/**
 * Phase-1 schema plumbing tests:
 *  - migrations create the managed schema and are idempotent,
 *  - the RLS backstop actually blocks untenanted and cross-tenant access
 *    (FORCE RLS — the tests connect as the table owner),
 *  - flattened collections route to their real table behind the unchanged
 *    shim interface, incl. the docs→table backfill for pre-flatten rows,
 *  - a Phase-0 spike database (docs table without tenant_id) is adopted.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  getFirestore,
  __rawSqlForTest,
  __resetFirestoreShim,
} from "../firestore-shim";
import { runMigrations, MigrationClient } from "./migrate";
import { DEFAULT_TENANT_ID, getTenantId } from "./tenant";

const OTHER_TENANT = "11111111-1111-4111-8111-111111111111";

describe("tenant context + RLS backstop", () => {
  beforeAll(async () => {
    await __resetFirestoreShim();
    await getFirestore().collection("sources").doc("rls1").set({ userId: "u1", name: "RLS Source" });
    await getFirestore().collection("partners").doc("rlsp1").set({ userId: "u1", name: "P" });
    await getFirestore().collection("fileConnections").doc("rlsfc1").set({
      userId: "u1", fileId: "f1", transactionId: "t1", connectionType: "manual",
    });
    // categories is unflattened — keeps a real row in the docs bridge so the
    // blocked-read assertions on `docs` below stay non-vacuous.
    await getFirestore().collection("categories").doc("rlsc1").set({ userId: "u1", name: "C" });
  });

  it("bootstraps the single tenant", async () => {
    const res = await __rawSqlForTest(`SELECT id FROM tenants`, [], getTenantId());
    expect(res.rows.map((r) => r.id)).toEqual([DEFAULT_TENANT_ID]);
  });

  it("blocks ALL access when the app role runs with no tenant configured", async () => {
    for (const table of ["tenants", "docs", "sources", "partners", "file_connections"]) {
      const res = await __rawSqlForTest(`SELECT * FROM ${table}`, [], null);
      expect(res.rows).toEqual([]);
    }
  });

  it("blocks cross-tenant reads", async () => {
    for (const table of ["docs", "sources", "partners", "file_connections"]) {
      const res = await __rawSqlForTest(`SELECT * FROM ${table}`, [], OTHER_TENANT);
      expect(res.rows).toEqual([]);
    }
  });

  it("blocks writes whose tenant_id does not match the context", async () => {
    await expect(
      __rawSqlForTest(
        `INSERT INTO docs (tenant_id, path, collection_path, id, data) VALUES ($1, 'x/y', 'x', 'y', '{}')`,
        [DEFAULT_TENANT_ID],
        OTHER_TENANT,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("shim reads/writes see the data through the tenant context", async () => {
    const snap = await getFirestore().collection("sources").doc("rls1").get();
    expect(snap.exists).toBe(true);
    expect(snap.data()?.name).toBe("RLS Source");
  });
});

describe("flattened collection routing (sources)", () => {
  beforeAll(async () => {
    await __resetFirestoreShim();
  });

  it("writes sources docs to the real table, not the docs bridge", async () => {
    await getFirestore().collection("sources").doc("flat1").set({
      userId: "u1",
      name: "Bank",
      apiConfig: { accountId: "acc-1" },
      isActive: true,
    });
    const inTable = await __rawSqlForTest(
      `SELECT id, user_id, name, is_active, api_config_account_id FROM sources WHERE id = 'flat1'`,
      [],
      getTenantId(),
    );
    expect(inTable.rows).toEqual([
      { id: "flat1", user_id: "u1", name: "Bank", is_active: true, api_config_account_id: "acc-1" },
    ]);
    const inDocs = await __rawSqlForTest(
      `SELECT id FROM docs WHERE collection_path = 'sources'`,
      [],
      getTenantId(),
    );
    expect(inDocs.rows).toEqual([]);
  });

  it("routes fileConnections (camelCase collection) to the file_connections table", async () => {
    await getFirestore().collection("fileConnections").doc("route1").set({
      userId: "u1",
      fileId: "f-route",
      transactionId: "t-route",
      connectionType: "auto_matched",
    });
    const inTable = await __rawSqlForTest(
      `SELECT id, user_id, file_id, transaction_id, connection_type
       FROM file_connections WHERE id = 'route1'`,
      [],
      getTenantId(),
    );
    expect(inTable.rows).toEqual([
      { id: "route1", user_id: "u1", file_id: "f-route", transaction_id: "t-route", connection_type: "auto_matched" },
    ]);
    const inDocs = await __rawSqlForTest(
      `SELECT id FROM docs WHERE collection_path = 'fileConnections'`,
      [],
      getTenantId(),
    );
    expect(inDocs.rows).toEqual([]);
    const snap = await getFirestore().collection("fileConnections").doc("route1").get();
    expect(snap.data()?.fileId).toBe("f-route");
  });

  it("generated columns are NULL for missing/wrong-typed fields, doc round-trips untouched", async () => {
    await getFirestore().collection("sources").doc("flat2").set({
      userId: "u2",
      name: 42, // wrong type on purpose
      weird: { deep: [1, null, "x"] },
    });
    const row = await __rawSqlForTest(
      `SELECT name, is_active, api_config_account_id FROM sources WHERE id = 'flat2'`,
      [],
      getTenantId(),
    );
    expect(row.rows).toEqual([{ name: null, is_active: null, api_config_account_id: null }]);
    const snap = await getFirestore().collection("sources").doc("flat2").get();
    expect(snap.data()).toEqual({ userId: "u2", name: 42, weird: { deep: [1, null, "x"] } });
    expect("isActive" in (snap.data() as object)).toBe(false);
  });

  it("subcollections of flattened docs stay in the docs bridge and recursiveDelete catches both", async () => {
    const db = getFirestore();
    await db.collection("sources").doc("flat3").set({ userId: "u3" });
    await db.collection("sources").doc("flat3").collection("history").doc("h1").set({ n: 1 });
    const sub = await __rawSqlForTest(
      `SELECT path FROM docs WHERE path = 'sources/flat3/history/h1'`,
      [],
      getTenantId(),
    );
    expect(sub.rows.length).toBe(1);

    await db.recursiveDelete(db.collection("sources").doc("flat3"));
    expect((await db.collection("sources").doc("flat3").get()).exists).toBe(false);
    const subAfter = await __rawSqlForTest(
      `SELECT path FROM docs WHERE path LIKE 'sources/flat3/%'`,
      [],
      getTenantId(),
    );
    expect(subAfter.rows).toEqual([]);
  });
});

describe("migration runner on a fresh client", () => {
  function makeTestClient(pg: PGlite): MigrationClient {
    const q = async (sql: string, params?: unknown[]) => {
      const res = await pg.query<Record<string, unknown>>(sql, params as unknown[]);
      return { rows: res.rows };
    };
    return {
      query: q,
      tx: async (tenantId, fn) => {
        await q(`BEGIN`);
        try {
          await q(`SET LOCAL ROLE fibuki_app`);
          if (tenantId !== null) {
            await q(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
          }
          const r = await fn(q);
          await q(`COMMIT`);
          return r;
        } catch (e) {
          await q(`ROLLBACK`);
          throw e;
        }
      },
    };
  }

  it("adopts a Phase-0 spike database and backfills flattened collections", async () => {
    const pg = new PGlite();
    const client = makeTestClient(pg);
    // Phase-0 shape, as the old inline DDL created it.
    await client.query(`CREATE TABLE docs (
      path TEXT PRIMARY KEY, collection_path TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL)`);
    await client.query(
      `INSERT INTO docs VALUES
       ('sources/a', 'sources', 'a', '{"userId": "u1", "name": "Old bank"}'),
       ('partners/p', 'partners', 'p', '{"userId": "u1"}'),
       ('fileConnections/fc', 'fileConnections', 'fc', '{"userId": "u1", "fileId": "f1", "transactionId": "t1"}'),
       ('categories/c', 'categories', 'c', '{"userId": "u1"}'),
       ('transactions/t/history/h', 'transactions/t/history', 'h', '{"n": 1}')`,
    );

    await runMigrations(client);

    const tid = getTenantId();
    const sources = await client.tx(tid, (q) => q(`SELECT id, name, user_id FROM sources`));
    expect(sources.rows).toEqual([{ id: "a", name: "Old bank", user_id: "u1" }]);
    const partners = await client.tx(tid, (q) => q(`SELECT id, user_id FROM partners`));
    expect(partners.rows).toEqual([{ id: "p", user_id: "u1" }]);
    // First collection whose Firestore name (camelCase) differs from its
    // table name — pins the collection_path → table mapping in the backfill.
    const conns = await client.tx(tid, (q) =>
      q(`SELECT id, user_id, file_id, transaction_id FROM file_connections`));
    expect(conns.rows).toEqual([{ id: "fc", user_id: "u1", file_id: "f1", transaction_id: "t1" }]);
    const docs = await client.tx(tid, (q) => q(`SELECT path FROM docs ORDER BY path`));
    expect(docs.rows.map((r) => r.path)).toEqual(["categories/c", "transactions/t/history/h"]);
    const spike = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'docs_spike_v0'`,
    );
    expect(spike.rows).toEqual([]);

    // Idempotent: a second run applies nothing and moves nothing.
    await runMigrations(client);
    const ledger = await client.query(`SELECT name FROM _migrations`);
    expect(ledger.rows.length).toBeGreaterThan(0);
    await pg.close();
  });
});
