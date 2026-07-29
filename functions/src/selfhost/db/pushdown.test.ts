/**
 * Differential suite for SQL pushdown: the SAME fixture docs are written to
 * the flattened `sources` collection (real table + compiled SQL) and to an
 * unflattened twin collection (JSONB docs bridge + pure JS pipeline, which
 * the parity suite pins against firebase-admin). Every query shape must
 * return identical results from both paths — that makes the JSONB path the
 * referee for the table path, transitively anchoring it to real Firestore.
 *
 * Known, accepted divergence NOT asserted here: a field holding MIXED types
 * across docs (e.g. a boolean field that is a string in one doc) can sort/
 * range differently once SQL LIMIT is pushed, because the generated column
 * is NULL for the wrong-typed doc while the JS comparator string-coerces.
 * Real Firestore brackets by type, agreeing with neither. TS-typed app data
 * does not mix types per field; do not "fix" this by disabling pushdown.
 *
 * Plus compile-shape unit tests pinning WHAT gets pushed (the perf contract
 * the differential assertions cannot see).
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  getFirestore,
  Timestamp,
  __resetFirestoreShim,
} from "../firestore-shim";
import { FLATTENED } from "./collections";
import { compileFlatQuery } from "./pushdown";
import { getTenantId } from "./tenant";

const db = getFirestore();
const FLAT = "sources"; // has a real table
const REF = "srcdiff"; // JSONB twin — no spec, pure JS pipeline

const T = (ms: number) => Timestamp.fromMillis(ms);

const FIXTURES: Record<string, Record<string, unknown>> = {
  s01: { userId: "u1", isActive: true, name: "Alpha", createdAt: T(1000), apiConfig: { accountId: "acc1" }, balance: 100, tags: ["a", "b"] },
  s02: { userId: "u1", isActive: false, name: "alpha", createdAt: T(2000), balance: 250 },
  s03: { userId: "u1", isActive: true, name: "Beta", createdAt: T(2000), linkedSourceId: "s01", tags: ["b"] },
  s04: { userId: "u2", isActive: true, name: "dup", createdAt: T(3000), apiConfig: { accountId: "acc2" } },
  s05: { userId: "u2", name: "dup", createdAt: T(4000) }, // isActive missing
  s06: { userId: "u2", isActive: null, name: null, createdAt: T(5000) },
  s07: { userId: "u1", isActive: true, createdAt: T(6000), balance: 100 }, // name missing
  s08: { userId: "u3", isActive: "yes", name: "Ätsch", apiConfig: { accountId: 7 } }, // wrong types, createdAt missing
  s09: { userId: "u1", isActive: true, name: "zeta", createdAt: T(7000), tags: [] },
  s10: { userId: "u2", isActive: false, name: "42", createdAt: T(1000) }, // createdAt tie with s01
};

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Build the same query against a collection, return ordered doc ids. */
type Build = (col: any) => Promise<any> | any;

async function idsFrom(collection: string, build: Build): Promise<string[]> {
  const q = await build(db.collection(collection));
  const snap = await q.get();
  return snap.docs.map((d: any) => d.id);
}

/** For queries WITH an orderBy: result order is defined and must match. */
async function expectSame(build: Build): Promise<string[]> {
  const a = await idsFrom(FLAT, build);
  const b = await idsFrom(REF, build);
  expect(a).toEqual(b);
  return a;
}

/**
 * For queries WITHOUT an orderBy: neither backend defines an order (the
 * JSONB path returns heap order, the table path whatever plan Postgres
 * picks, e.g. an index scan) — compare as sets.
 */
async function expectSameSet(build: Build): Promise<string[]> {
  const a = await idsFrom(FLAT, build);
  const b = await idsFrom(REF, build);
  expect([...a].sort()).toEqual([...b].sort());
  return a;
}

describe("pushdown differential: flattened table vs JSONB reference", () => {
  beforeAll(async () => {
    await __resetFirestoreShim();
    for (const [id, data] of Object.entries(FIXTURES)) {
      await db.collection(FLAT).doc(id).set(data);
      await db.collection(REF).doc(id).set(data);
    }
  });

  it("equality on mapped fields", async () => {
    expect(await expectSameSet((c) => c.where("userId", "==", "u1"))).toHaveLength(5);
    await expectSameSet((c) => c.where("userId", "==", "u1").where("isActive", "==", true));
    await expectSameSet((c) => c.where("apiConfig.accountId", "==", "acc1"));
    await expectSameSet((c) => c.where("isActive", "==", true)); // s08 "yes" matches neither path
    await expectSameSet((c) => c.where("createdAt", "==", T(2000)));
    await expectSameSet((c) => c.where("userId", "==", "nobody"));
  });

  it("null equality stays JS-side and matches explicit null only", async () => {
    expect(await expectSameSet((c) => c.where("name", "==", null))).toEqual(["s06"]);
  });

  it("ranges on text, incl. null-as-minus-infinity", async () => {
    await expectSameSet((c) => c.where("name", ">", "Beta"));
    expect(await expectSameSet((c) => c.where("name", "<=", "alpha"))).toContain("s06");
    await expectSameSet((c) => c.where("name", "<", "B"));
    await expectSameSet((c) => c.where("name", ">=", "A").where("name", "<", "z"));
  });

  it("ranges on timestamps", async () => {
    await expectSameSet((c) => c.where("createdAt", ">", T(2000)));
    await expectSameSet((c) => c.where("createdAt", ">=", T(2000)));
    expect(await expectSameSet((c) => c.where("createdAt", "<=", T(2000)))).not.toContain("s08");
  });

  it("in / not-in / != / __name__", async () => {
    await expectSameSet((c) => c.where("userId", "in", ["u1", "u3"]));
    await expectSameSet((c) => c.where("userId", "in", []));
    await expectSameSet((c) => c.where("isActive", "!=", true));
    await expectSameSet((c) => c.where("userId", "not-in", ["u1"]));
    expect(await expectSameSet((c) => c.where("__name__", "==", "s04"))).toEqual(["s04"]);
    await expectSameSet((c) => c.where("__name__", "in", ["s01", "s09", "sources/s10"]));
  });

  it("array-contains stays JS-side, same results", async () => {
    await expectSameSet((c) => c.where("tags", "array-contains", "b"));
    await expectSameSet((c) => c.where("tags", "array-contains-any", ["a", "c"]));
  });

  it("orderBy with nulls/missing first-or-last and id tiebreak", async () => {
    await expectSame((c) => c.orderBy("name", "asc"));
    await expectSame((c) => c.orderBy("name", "desc"));
    await expectSame((c) => c.orderBy("createdAt", "asc"));
    await expectSame((c) => c.orderBy("createdAt", "desc"));
    await expectSame((c) => c.orderBy("createdAt", "asc").orderBy("name", "desc"));
  });

  it("limit/offset pushdown", async () => {
    await expectSame((c) => c.orderBy("createdAt", "asc").limit(3));
    await expectSame((c) => c.orderBy("createdAt", "desc").limit(2).offset(2));
    await expectSame((c) => c.where("userId", "==", "u1").orderBy("name", "asc").limit(2));
    await expectSame((c) => c.orderBy("createdAt", "asc").orderBy("name", "asc").limit(4));
  });

  it("startAfter(snapshot) cursor with id tiebreak, paged to exhaustion", async () => {
    const page = async (col: any, after?: any) => {
      let q = col.orderBy("name", "asc").limit(3);
      if (after) q = q.startAfter(after);
      return q.get();
    };
    for (const collection of [FLAT, REF]) {
      const col = db.collection(collection);
      const all: string[] = [];
      let snap = await page(col);
      while (snap.docs.length > 0) {
        all.push(...snap.docs.map((d: any) => d.id));
        snap = await page(col, snap.docs[snap.docs.length - 1]);
      }
      expect(all).toHaveLength(Object.keys(FIXTURES).length);
      if (collection === REF) {
        const flatAll = await idsFrom(FLAT, (c) => c.orderBy("name", "asc"));
        expect(all).toEqual(flatAll);
      }
    }
  });

  it("startAfter(values) cursor", async () => {
    await expectSame((c) => c.orderBy("createdAt", "asc").startAfter(T(2000)));
    await expectSame((c) => c.orderBy("name", "asc").startAfter("dup").limit(2));
  });

  it("count() and full-data round-trip equality", async () => {
    const [ca, cb] = await Promise.all(
      [FLAT, REF].map((n) =>
        db.collection(n).where("userId", "==", "u1").count().get().then((s) => s.data().count),
      ),
    );
    expect(ca).toBe(cb);

    const [da, dbb] = await Promise.all(
      [FLAT, REF].map((n) => db.collection(n).orderBy("createdAt", "asc").get()),
    );
    expect(da.docs.map((d: any) => d.data())).toEqual(dbb.docs.map((d: any) => d.data()));
  });

  it("limit without orderBy returns the right count (order is backend-arbitrary)", async () => {
    const [a, b] = await Promise.all(
      [FLAT, REF].map((n) => db.collection(n).where("userId", "==", "u2").limit(2).get()),
    );
    expect(a.size).toBe(2);
    expect(b.size).toBe(2);
  });
});

describe("compile shapes (the perf contract)", () => {
  const spec = FLATTENED.sources;
  const tid = getTenantId();

  it("pushes equality + order + limit fully", () => {
    const c = compileFlatQuery(
      spec,
      tid,
      [{ field: "userId", op: "==", value: "u1" }],
      [{ field: "name", dir: "asc" }],
      3,
      0,
      null,
    );
    expect(c.sql).toContain(`"user_id" = $2`);
    expect(c.sql).toContain(`ORDER BY "name" COLLATE "C" ASC NULLS FIRST, id COLLATE "C" ASC`);
    expect(c.sql).toContain(`LIMIT 3`);
    expect(c.params).toEqual([tid, "u1"]);
  });

  it("folds offset into the pushed LIMIT", () => {
    const c = compileFlatQuery(spec, tid, [], [{ field: "createdAt", dir: "desc" }], 2, 2, null);
    expect(c.sql).toContain(`LIMIT 4`);
  });

  it("does NOT push LIMIT when a filter stays JS-side", () => {
    const c = compileFlatQuery(
      spec,
      tid,
      [{ field: "tags", op: "array-contains", value: "b" }],
      [{ field: "name", dir: "asc" }],
      3,
      0,
      null,
    );
    expect(c.sql).not.toContain("LIMIT");
    expect(c.sql).toContain("ORDER BY");
  });

  it("does NOT push LIMIT or ORDER BY for unmapped order fields", () => {
    const c = compileFlatQuery(spec, tid, [], [{ field: "balance", dir: "asc" }], 3, 0, null);
    expect(c.sql).not.toContain("ORDER BY");
    expect(c.sql).not.toContain("LIMIT");
  });

  it("compiles a snapshot cursor to a keyset with id tiebreak", () => {
    const c = compileFlatQuery(
      spec,
      tid,
      [],
      [{ field: "name", dir: "asc" }],
      2,
      0,
      { values: ["dup"], snapId: "s04" },
    );
    expect(c.sql).toContain(`"name" COLLATE "C" > $2`);
    expect(c.sql).toContain(`"name" = $2 AND id COLLATE "C" > $3`);
    expect(c.sql).toContain("LIMIT 2");
    expect(c.params).toEqual([tid, "dup", "s04"]);
  });

  it("null cursor values disable LIMIT pushdown but keep the fetch valid", () => {
    const c = compileFlatQuery(
      spec,
      tid,
      [],
      [{ field: "name", dir: "asc" }],
      2,
      0,
      { values: [null], snapId: "s06" },
    );
    expect(c.sql).not.toContain("LIMIT");
  });
});

/**
 * Transactions is the first collection to lean on the timestamp keyset-cursor
 * path in production shapes. The fixtures mirror the app's hot queries:
 * tools/handlers.ts listTransactions (userId == + date range + orderBy date
 * desc + startAfter(snap) + limit) and the bank-sync dedupe scans
 * (dedupeHash `in` chunks and `>= iban| AND < iban|~` prefix ranges).
 *
 * NOTE: `date` is only ever a Timestamp, json-null, or absent here — a
 * wrong-typed date under a pushed LIMIT is the header's accepted divergence,
 * so the wrong-typed fixture value sits on isComplete instead (like s08).
 */
describe("pushdown differential: transactions shapes", () => {
  const TXFLAT = "transactions";
  const TXREF = "txdiff"; // JSONB twin — no spec, pure JS pipeline

  const TXFIXTURES: Record<string, Record<string, unknown>> = {
    t01: { userId: "u1", sourceId: "s1", date: T(1000), createdAt: T(1000), dedupeHash: "AT1|a", isComplete: false },
    t02: { userId: "u1", sourceId: "s1", date: T(2000), createdAt: T(1500), dedupeHash: "AT1|b", isComplete: true, partnerId: "p1", partnerMatchedBy: "manual" },
    t03: { userId: "u1", sourceId: "s2", date: T(2000), dedupeHash: "AT2|a", isComplete: false, partnerId: "p1", partnerMatchedBy: "auto" },
    t04: { userId: "u1", date: T(3000), isComplete: false, partnerMatchedBy: "ai", quotaExceeded: true },
    t05: { userId: "u1", isComplete: false }, // date missing
    t06: { userId: "u1", date: null, quotaExceeded: true },
    t07: { userId: "u2", sourceId: "s3", date: T(1500), dedupeHash: "AT1|c", importJobId: "job1" },
    t08: { userId: "u1", date: T(5000), isComplete: "yes" }, // wrong-typed boolean
    t09: { userId: "u1", sourceId: "s1", date: T(4000), importJobId: "job1", noReceiptCategoryId: "cat1", noReceiptCategoryMatchedBy: "suggestion" },
    t10: { userId: "u1", sourceId: "s1", date: T(2000), dedupeHash: "AT1|d", isComplete: true }, // date tie with t02/t03
  };

  beforeAll(async () => {
    await __resetFirestoreShim();
    for (const [id, data] of Object.entries(TXFIXTURES)) {
      await db.collection(TXFLAT).doc(id).set(data);
      await db.collection(TXREF).doc(id).set(data);
    }
  });

  async function sameTx(build: Build): Promise<string[]> {
    const a = await idsFrom(TXFLAT, build);
    const b = await idsFrom(TXREF, build);
    expect(a).toEqual(b);
    return a;
  }

  async function sameTxSet(build: Build): Promise<string[]> {
    const a = await idsFrom(TXFLAT, build);
    const b = await idsFrom(TXREF, build);
    expect([...a].sort()).toEqual([...b].sort());
    return a;
  }

  it("listTransactions shape: date range + orderBy desc + limit, ties broken by id", async () => {
    await sameTx((c) =>
      c
        .where("userId", "==", "u1")
        .where("date", ">=", T(1000))
        .where("date", "<", T(4000))
        .orderBy("date", "desc")
        .limit(3),
    );
  });

  it("listTransactions cursor: startAfter(snapshot) paged to exhaustion over ties and nulls", async () => {
    const page = async (col: any, after?: any) => {
      let q = col.where("userId", "==", "u1").orderBy("date", "desc").limit(2);
      if (after) q = q.startAfter(after);
      return q.get();
    };
    const perBackend: string[][] = [];
    for (const collection of [TXFLAT, TXREF]) {
      const col = db.collection(collection);
      const all: string[] = [];
      let snap = await page(col);
      while (snap.docs.length > 0) {
        all.push(...snap.docs.map((d: any) => d.id));
        snap = await page(col, snap.docs[snap.docs.length - 1]);
      }
      perBackend.push(all);
    }
    expect(perBackend[0]).toEqual(perBackend[1]);
    expect(perBackend[0]).toHaveLength(9); // all u1 docs, incl. missing/null dates
  });

  it("bank-sync dedupe shapes: `in` chunk and iban| prefix range", async () => {
    await sameTxSet((c) => c.where("userId", "==", "u1").where("dedupeHash", "in", ["AT1|a", "AT1|d", "AT9|x"]));
    expect(
      await sameTxSet((c) => c.where("userId", "==", "u1").where("dedupeHash", ">=", "AT1|").where("dedupeHash", "<", "AT1|~")),
    ).toEqual(expect.arrayContaining(["t01", "t02", "t10"]));
    await sameTxSet((c) => c.where("sourceId", "==", "s1").where("dedupeHash", "in", ["AT1|b"]));
  });

  it("matcher shapes: matchedBy `in`, isComplete ==, importJobId ==, quotaExceeded ==", async () => {
    await sameTxSet((c) => c.where("userId", "==", "u1").where("partnerId", "==", "p1").where("partnerMatchedBy", "in", ["manual", "suggestion", "ai"]));
    await sameTx((c) => c.where("userId", "==", "u1").where("isComplete", "==", false).orderBy("date", "desc").limit(3));
    await sameTxSet((c) => c.where("userId", "==", "u1").where("importJobId", "==", "job1"));
    await sameTxSet((c) => c.where("userId", "==", "u1").where("quotaExceeded", "==", true));
    await sameTxSet((c) => c.where("userId", "==", "u1").where("noReceiptCategoryId", "==", "cat1").where("noReceiptCategoryMatchedBy", "in", ["manual", "suggestion"]));
  });

  it("createdAt range (digest shape) and __name__ in (enrichment batches)", async () => {
    await sameTxSet((c) => c.where("userId", "==", "u1").where("createdAt", ">=", T(1200)));
    await sameTxSet((c) => c.where("__name__", "in", ["t01", "t07", "transactions/t09"]));
  });
});

/**
 * Files pins only what sources + transactions don't already: the
 * processOrphanedFiles stale-scan (a `<`-only timestamp range ordered ASC on
 * the same field — json-null rows are in play UNDER a pushed LIMIT, since
 * they match `<` as JS -Infinity and sort first as SQL NULLS FIRST), the
 * onPartnerUpdate re-match combo (a JS-side `partnerId == null` alongside
 * pushed filters must withhold LIMIT), and bulkRetryExtraction's
 * `extractionError != null` (never pushed; explicit-null and missing both
 * excluded by the JS referee).
 *
 * Fixture rule (header): updatedAt drives ordered-limit assertions, so the
 * wrong-typed value sits on extractionComplete instead.
 */
describe("pushdown differential: files shapes", () => {
  const FFLAT = "files";
  const FREF = "filediff"; // JSONB twin — no spec, pure JS pipeline

  const FFIXTURES: Record<string, Record<string, unknown>> = {
    f01: { userId: "u1", extractionComplete: true, partnerMatchComplete: true, partnerId: "p1", partnerMatchedBy: "auto", updatedAt: T(1000), uploadedAt: T(1000), contentHash: "h1" },
    f02: { userId: "u1", extractionComplete: true, partnerMatchComplete: true, partnerId: null, updatedAt: T(2000), extractionError: "extract boom" },
    f03: { userId: "u1", extractionComplete: true, partnerMatchComplete: true, updatedAt: T(2000) }, // partnerId missing — not an == null match; updatedAt tie with f02
    f04: { userId: "u1", extractionComplete: false, updatedAt: T(3000), extractionError: null }, // explicit null — excluded by != null
    f05: { userId: "u1", extractionComplete: true, updatedAt: null }, // json-null: matches `<`, sorts first
    f06: { userId: "u1", extractionComplete: true }, // updatedAt missing: excluded from `<` by both paths
    f07: { userId: "u2", extractionComplete: true, partnerMatchComplete: true, partnerId: null }, // other user
    f08: { userId: "u1", extractionComplete: "yes", updatedAt: T(1500), extractionError: "parse failed" }, // wrong-typed boolean
    f09: { userId: "u1", extractionComplete: true, gmailMessageId: "m1", gmailAttachmentId: "a1", sourceType: "gmail_html_invoice", uploadedAt: T(4000), extractedDate: T(2000), transactionMatchComplete: true },
    f10: { userId: "u1", extractionComplete: true, partnerMatchComplete: true, updatedAt: T(5000) }, // past the stale cutoff
  };

  beforeAll(async () => {
    await __resetFirestoreShim();
    for (const [id, data] of Object.entries(FFIXTURES)) {
      await db.collection(FFLAT).doc(id).set(data);
      await db.collection(FREF).doc(id).set(data);
    }
  });

  async function sameF(build: Build): Promise<string[]> {
    const a = await idsFrom(FFLAT, build);
    const b = await idsFrom(FREF, build);
    expect(a).toEqual(b);
    return a;
  }

  async function sameFSet(build: Build): Promise<string[]> {
    const a = await idsFrom(FFLAT, build);
    const b = await idsFrom(FREF, build);
    expect([...a].sort()).toEqual([...b].sort());
    return a;
  }

  it("stale-scan shape: `<` range + orderBy same field asc + limit, json-null under the pushed LIMIT", async () => {
    expect(
      await sameF((c) =>
        c
          .where("extractionComplete", "==", true)
          .where("updatedAt", "<", T(4000))
          .orderBy("updatedAt", "asc")
          .limit(3),
      ),
    ).toEqual(["f05", "f01", "f02"]); // json-null first, then values; f02/f03 tie broken by id
    await sameF((c) =>
      c.where("extractionComplete", "==", true).where("updatedAt", "<", T(4000)).orderBy("updatedAt", "asc"),
    );
  });

  it("re-match shape: JS-side partnerId == null alongside pushed filters + limit", async () => {
    expect(
      await sameFSet((c) =>
        c
          .where("userId", "==", "u1")
          .where("partnerId", "==", null)
          .where("extractionComplete", "==", true)
          .where("partnerMatchComplete", "==", true)
          .limit(5),
      ),
    ).toEqual(["f02"]); // explicit null only — f03 (missing) and f07 (u2) excluded
  });

  it("retry shape: extractionError != null excludes explicit-null and missing", async () => {
    expect(
      (await sameFSet((c) => c.where("userId", "==", "u1").where("extractionError", "!=", null))).sort(),
    ).toEqual(["f02", "f08"]);
  });
});

describe("compile shapes: files (the perf contract)", () => {
  const spec = FLATTENED.files;
  const tid = getTenantId();

  it("pushes the stale-scan incl. LIMIT: ASC NULLS FIRST and `<` ORs in json-null", () => {
    const c = compileFlatQuery(
      spec,
      tid,
      [
        { field: "extractionComplete", op: "==", value: true },
        { field: "updatedAt", op: "<", value: T(4000) },
      ],
      [{ field: "updatedAt", dir: "asc" }],
      64,
      0,
      null,
    );
    expect(c.sql).toContain("LIMIT 64"); // timestamp < stays exact
    expect(c.sql).toContain(`"updated_at" < $3 OR jsonb_typeof("data"->'updatedAt') = 'null'`);
    expect(c.sql).toContain(`ORDER BY "updated_at" ASC NULLS FIRST, id COLLATE "C" ASC`);
  });

  it("withholds LIMIT when null-equality or != stays JS-side", () => {
    const c = compileFlatQuery(
      spec,
      tid,
      [
        { field: "userId", op: "==", value: "u1" },
        { field: "partnerId", op: "==", value: null },
        { field: "extractionError", op: "!=", value: null },
      ],
      [{ field: "updatedAt", dir: "asc" }],
      5,
      0,
      null,
    );
    expect(c.sql).not.toContain("LIMIT");
    expect(c.sql).not.toContain("partner_id");
    expect(c.sql).not.toContain("extraction_error");
    expect(c.sql).toContain(`"user_id" = $2`);
    expect(c.sql).toContain("ORDER BY"); // order still pushes; JS re-sorts anyway
  });
});

describe("compile shapes: transactions (the perf contract)", () => {
  const spec = FLATTENED.transactions;
  const tid = getTenantId();

  it("pushes the full tools/handlers.ts listTransactions shape incl. LIMIT", () => {
    const c = compileFlatQuery(
      spec,
      tid,
      [
        { field: "userId", op: "==", value: "u1" },
        { field: "date", op: ">=", value: T(1000) },
        { field: "date", op: "<", value: T(4000) },
      ],
      [{ field: "date", dir: "desc" }],
      50,
      0,
      { values: [T(2000)], snapId: "t03" },
    );
    // timestamp < stays exact (only text < is a superset), so LIMIT pushes
    expect(c.sql).toContain("LIMIT 50");
    // desc keyset: strictly-below branch treats NULL (missing/json-null,
    // JS -Infinity) as past every value, then the id tiebreak branch
    expect(c.sql).toContain(`("date" < $5 OR "date" IS NULL)`);
    expect(c.sql).toContain(`"date" = $5 AND id COLLATE "C" < $6`);
    expect(c.sql).toContain(`ORDER BY "date" DESC NULLS LAST, id COLLATE "C" DESC`);
  });

  it("pushes the dedupe prefix-range with LIMIT withheld only when unordered", () => {
    const c = compileFlatQuery(
      spec,
      tid,
      [
        { field: "userId", op: "==", value: "u1" },
        { field: "dedupeHash", op: ">=", value: "AT1|" },
        { field: "dedupeHash", op: "<", value: "AT1|~" },
      ],
      [],
      null,
      0,
      null,
    );
    expect(c.sql).toContain(`"user_id" = $2`);
    expect(c.sql).toContain(`"dedupe_hash" COLLATE "C" >= $3`);
    // text < ORs in json-null rows (superset; JS re-verifies)
    expect(c.sql).toContain(`"dedupe_hash" COLLATE "C" < $4 OR jsonb_typeof("data"->'dedupeHash') = 'null'`);
  });
});
