/**
 * Firestore API PARITY suite.
 *
 * The exact same assertions run against BOTH backends:
 *   1. "shim"           — src/selfhost/firestore-shim.ts (PGlite in-memory).
 *                          Always runs; needs no external service.
 *   2. "firebase-admin" — the real firebase-admin/firestore SDK against the
 *                          Firestore emulator. Skipped unless
 *                          FIRESTORE_EMULATOR_HOST is set. Run with:
 *
 *   npx firebase emulators:exec --only firestore --project demo-fibuki \
 *     "cd functions && npx vitest run src/test/firestore-parity.test.ts"
 *
 * Scope: derived from the app's ACTUAL Firestore call sites (grep of
 * functions/src outside selfhost/ and tests), NOT from what the shim happens
 * to implement. Inventory: doc/collection CRUD, set-merge, FieldValue
 * sentinels, Timestamp, where (==, !=, ranges, "in" ≤30, array-contains),
 * orderBy/limit, count() (sendWeeklyDigest, mfaFunctions, openSeats, …),
 * select() (analyzeMatchAccuracy, learnScoringWeights,
 * learnPartnerCategoryPatterns), collectionGroup (learningQueue.ts:107),
 * getAll (admin/userManagement.ts), batches, transactions, startAfter
 * cursors (tools/handlers.ts:228,
 * precision-search/precisionSearchQueue.ts:1953), and admin's DEFAULT
 * undefined-value rejection — no .settings()/ignoreUndefinedProperties call
 * exists anywhere in the app, so any optional TS field reaching a write
 * throws today.
 *
 * Audited out of scope against those call sites: ">30 values in an 'in'
 * filter" error enforcement — every dynamic 'in' site chunks to exactly 30
 * (searchGmailCallable, syncBankTransactions, matchFileTransactions,
 * learnScoringWeights, learnBillingCycle, exportMatchIntelligence,
 * finapi/syncCallable slice(0,30)), so the error path is unreachable from
 * app code, while the 30-value boundary itself IS asserted below. onSnapshot
 * and createTime/updateTime fidelity: no call sites in functions/src.
 * Assertions kept beyond the inventory (offset, not-in, array-contains-any,
 * recursiveDelete) are safety margin, not app surface.
 *
 * Former SHIM GAPS, closed 2026-07-17: startAfter(docSnapshot) cursors,
 * admin-default undefined-value rejection, and __name__/documentId filters
 * (learnBillingCycle.ts computeInvoiceDelays — missed by the original
 * call-site inventory) are now implemented in the shim; both halves run the
 * same assertions with no per-backend branches for them.
 *
 * Where shim and admin genuinely diverge on app-relevant surface, the test
 * pins BOTH behaviors via a per-backend branch marked KNOWN DIVERGENCE.
 */

import { describe, it, expect, beforeAll } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface BackendCtx {
  db: any;
  FieldValue: any;
  Timestamp: any;
}

// Unique per vitest run so repeated runs against a long-lived emulator (or a
// persistent Postgres behind the shim) never see stale documents.
const RUN = `parity${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function runParitySuite(
  name: "shim" | "firebase-admin",
  makeDb: () => Promise<BackendCtx>,
  opts: { skip?: boolean } = {},
): void {
  const d = opts.skip ? describe.skip : describe;

  d(`firestore parity [${name}]`, () => {
    let db: any;
    let FieldValue: any;
    let Timestamp: any;
    let seq = 0;

    beforeAll(async () => {
      ({ db, FieldValue, Timestamp } = await makeDb());
    });

    /** Fresh, uniquely-named collection for a test. */
    const freshCol = (label: string) => db.collection(`${RUN}_${label}_${seq++}`);

    const seed = async (col: any, docs: Record<string, Record<string, unknown>>) => {
      await Promise.all(Object.entries(docs).map(([id, data]) => col.doc(id).set(data)));
    };

    const idsOf = (snap: any): string[] => snap.docs.map((doc: any) => doc.id);

    // ------------------------------------------------------------------
    // Documents: get / set / add / create / delete
    // ------------------------------------------------------------------

    it("set() + get() round-trips primitives, nested maps, arrays and null", async () => {
      const col = freshCol("roundtrip");
      const data = {
        str: "hello wörld",
        int: 42,
        float: 3.25,
        neg: -7,
        boolT: true,
        boolF: false,
        nul: null,
        arr: [1, "two", true, null, { nested: "in-array" }],
        map: { a: 1, deep: { b: "x", list: [1, 2] } },
      };
      await col.doc("d1").set(data);
      const snap = await col.doc("d1").get();
      expect(snap.exists).toBe(true);
      expect(snap.id).toBe("d1");
      expect(snap.data()).toEqual(data);
    });

    it("field names matching __...__ in writes; __proto__ never pollutes", async () => {
      const col = freshCol("reserved");
      // Computed keys on purpose: a literal "__proto__" key in an object
      // literal would set the prototype instead of defining the property.
      if (name === "shim") {
        await expect(col.doc("a").set({ ["__proto__"]: { polluted: true } })).rejects.toThrow();
        await expect(col.doc("a").set({ nested: { ["__evil__"]: 1 } })).rejects.toThrow();
        await col.doc("b").set({ ok: 1 });
        await expect(col.doc("b").update({ ["__proto__.polluted"]: true })).rejects.toThrow();
        expect((await col.doc("b").get()).data()).toEqual({ ok: 1 });
      } else {
        // KNOWN DIVERGENCE: production Firestore documents __.*__ field
        // names as reserved; the emulator + admin SDK ACCEPT the write but
        // the field never round-trips — data() comes back empty (the SDK's
        // own decode can't represent a "__proto__" field either). The shim
        // rejects the write loudly instead: matches the documented contract
        // and closes the prototype-pollution class (user-supplied field
        // names must never walk "__proto__"). No app code writes such names.
        await col.doc("a").set({ ["__proto__"]: { marker: 1 } });
        const snap = await col.doc("a").get();
        expect(snap.exists).toBe(true);
        expect(snap.data()).toEqual({});
      }
      // Whichever backend, this process must stay unpolluted.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("get() on a missing doc: exists=false, data()=undefined, id preserved", async () => {
      const col = freshCol("missing");
      const snap = await col.doc("nope").get();
      expect(snap.exists).toBe(false);
      expect(snap.data()).toBeUndefined();
      expect(snap.id).toBe("nope");
    });

    it("snapshot.get(field) supports dot paths and returns undefined for missing fields", async () => {
      const col = freshCol("snapget");
      await col.doc("d").set({ a: { b: { c: 7 } }, top: "t" });
      const snap = await col.doc("d").get();
      expect(snap.get("top")).toBe("t");
      expect(snap.get("a.b.c")).toBe(7);
      expect(snap.get("a.b")).toEqual({ c: 7 });
      expect(snap.get("does.not.exist")).toBeUndefined();
      expect(snap.get("nope")).toBeUndefined();
    });

    it("set() without merge fully overwrites the existing document", async () => {
      const col = freshCol("overwrite");
      await col.doc("d").set({ a: 1, b: { x: 1 }, gone: "yes" });
      await col.doc("d").set({ a: 2 });
      const snap = await col.doc("d").get();
      expect(snap.data()).toEqual({ a: 2 });
    });

    it("set(merge:true) merges top-level fields, preserving untouched ones", async () => {
      const col = freshCol("merge");
      await col.doc("d").set({ keep: "old", change: 1 });
      await col.doc("d").set({ change: 2, added: true }, { merge: true });
      const snap = await col.doc("d").get();
      expect(snap.data()).toEqual({ keep: "old", change: 2, added: true });
    });

    it("set(merge:true) with a nested map value", async () => {
      const col = freshCol("mergenested");
      await col.doc("d").set({ m: { x: 1, y: 2 }, other: "o" });
      await col.doc("d").set({ m: { y: 9 } }, { merge: true });
      const snap = await col.doc("d").get();
      if (name === "shim") {
        // KNOWN DIVERGENCE: real Firestore set(merge:true) merges maps
        // recursively (m.x survives); the shim replaces each top-level key
        // wholesale, so the nested map is overwritten.
        expect(snap.data()).toEqual({ m: { y: 9 }, other: "o" });
      } else {
        expect(snap.data()).toEqual({ m: { x: 1, y: 9 }, other: "o" });
      }
    });

    it("set(merge:true) on a missing doc creates it", async () => {
      const col = freshCol("mergecreate");
      await col.doc("d").set({ a: 1 }, { merge: true });
      const snap = await col.doc("d").get();
      expect(snap.exists).toBe(true);
      expect(snap.data()).toEqual({ a: 1 });
    });

    it("add() and doc() generate 20-char alphanumeric ids and store the doc", async () => {
      const col = freshCol("add");
      const ref = await col.add({ via: "add" });
      expect(ref.id).toMatch(/^[A-Za-z0-9]{20}$/);
      const snap = await ref.get();
      expect(snap.data()).toEqual({ via: "add" });

      const autoRef = col.doc();
      expect(autoRef.id).toMatch(/^[A-Za-z0-9]{20}$/);
      expect(autoRef.id).not.toBe(ref.id);
    });

    it("db.doc(path) resolves refs; ref.path/id/parent and collection id/path agree", async () => {
      const colName = `${RUN}_paths_${seq++}`;
      const ref = db.doc(`${colName}/abc`);
      expect(ref.id).toBe("abc");
      expect(ref.path).toBe(`${colName}/abc`);
      expect(ref.parent.path).toBe(colName);
      expect(ref.parent.id).toBe(colName);

      const sub = ref.collection("subitems");
      expect(sub.path).toBe(`${colName}/abc/subitems`);
      expect(sub.id).toBe("subitems");
      expect(sub.doc("x").path).toBe(`${colName}/abc/subitems/x`);

      await ref.set({ ok: true });
      const viaCollection = await db.collection(colName).doc("abc").get();
      expect(viaCollection.data()).toEqual({ ok: true });
    });

    it("db.doc() rejects paths with an odd number of segments", () => {
      expect(() => db.doc("onlycollection")).toThrow();
      expect(() => db.doc("a/b/c")).toThrow();
    });

    it("create() succeeds on a fresh doc and rejects on an existing one", async () => {
      const col = freshCol("create");
      const res = await col.doc("d").create({ fresh: true });
      expect(res.writeTime).toBeInstanceOf(Timestamp);
      expect((await col.doc("d").get()).data()).toEqual({ fresh: true });
      await expect(col.doc("d").create({ again: true })).rejects.toThrow();
      // Original doc untouched by the failed create.
      expect((await col.doc("d").get()).data()).toEqual({ fresh: true });
    });

    it("delete() removes a doc and resolves fine on an already-missing doc", async () => {
      const col = freshCol("delete");
      await col.doc("d").set({ a: 1 });
      await col.doc("d").delete();
      expect((await col.doc("d").get()).exists).toBe(false);
      await expect(col.doc("never-existed").delete()).resolves.toBeDefined();
    });

    it("set()/update() return a WriteResult with a Timestamp writeTime", async () => {
      const col = freshCol("writeresult");
      const setRes = await col.doc("d").set({ a: 1 });
      expect(setRes.writeTime).toBeInstanceOf(Timestamp);
      const updRes = await col.doc("d").update({ a: 2 });
      expect(updRes.writeTime).toBeInstanceOf(Timestamp);
    });

    // ------------------------------------------------------------------
    // update()
    // ------------------------------------------------------------------

    it("update() changes named fields and preserves the rest", async () => {
      const col = freshCol("update");
      await col.doc("d").set({ a: 1, b: "keep", c: { deep: true } });
      await col.doc("d").update({ a: 2, added: "new" });
      const snap = await col.doc("d").get();
      expect(snap.data()).toEqual({ a: 2, b: "keep", c: { deep: true }, added: "new" });
    });

    it("update() on a missing doc rejects and does not create the doc", async () => {
      const col = freshCol("updatemissing");
      await expect(col.doc("ghost").update({ a: 1 })).rejects.toThrow();
      expect((await col.doc("ghost").get()).exists).toBe(false);
    });

    it("update() dot-path writes only the leaf, preserving map siblings", async () => {
      const col = freshCol("dotpath");
      await col.doc("d").set({ m: { keep: 1, change: 2 }, top: "t" });
      await col.doc("d").update({ "m.change": 99 });
      const snap = await col.doc("d").get();
      expect(snap.data()).toEqual({ m: { keep: 1, change: 99 }, top: "t" });
    });

    it("update() dot-path creates intermediate maps when parents are missing", async () => {
      const col = freshCol("dotpathdeep");
      await col.doc("d").set({ top: "t" });
      await col.doc("d").update({ "a.b.c": 7 });
      const snap = await col.doc("d").get();
      expect(snap.data()).toEqual({ top: "t", a: { b: { c: 7 } } });
    });

    it("update() with a plain map value replaces the whole map field", async () => {
      const col = freshCol("mapreplace");
      await col.doc("d").set({ m: { keep: 1, change: 2 } });
      await col.doc("d").update({ m: { change: 99 } });
      const snap = await col.doc("d").get();
      expect(snap.data()).toEqual({ m: { change: 99 } });
    });

    // ------------------------------------------------------------------
    // FieldValue sentinels
    // ------------------------------------------------------------------

    it("serverTimestamp() in set() resolves to a Timestamp near now, incl. nested in maps", async () => {
      const col = freshCol("servertime");
      const before = Date.now();
      await col.doc("d").set({
        at: FieldValue.serverTimestamp(),
        meta: { createdAt: FieldValue.serverTimestamp() },
      });
      const snap = await col.doc("d").get();
      const at = snap.get("at");
      const nested = snap.get("meta.createdAt");
      expect(at).toBeInstanceOf(Timestamp);
      expect(nested).toBeInstanceOf(Timestamp);
      expect(Math.abs(at.toMillis() - before)).toBeLessThan(60_000);
      expect(Math.abs(nested.toMillis() - before)).toBeLessThan(60_000);
    });

    it("serverTimestamp() in update() resolves to a Timestamp near now", async () => {
      const col = freshCol("servertimeupd");
      await col.doc("d").set({ a: 1 });
      const before = Date.now();
      await col.doc("d").update({ touchedAt: FieldValue.serverTimestamp() });
      const snap = await col.doc("d").get();
      expect(snap.get("a")).toBe(1);
      expect(snap.get("touchedAt")).toBeInstanceOf(Timestamp);
      expect(Math.abs(snap.get("touchedAt").toMillis() - before)).toBeLessThan(60_000);
    });

    it("increment() starts from 0 on an absent field and accumulates on an existing one", async () => {
      const col = freshCol("increment");
      await col.doc("d").set({ other: "x" });
      await col.doc("d").update({ n: FieldValue.increment(5) });
      expect((await col.doc("d").get()).get("n")).toBe(5);
      await col.doc("d").update({ n: FieldValue.increment(-2) });
      expect((await col.doc("d").get()).get("n")).toBe(3);
      await col.doc("d").update({ n: FieldValue.increment(0.5) });
      expect((await col.doc("d").get()).get("n")).toBe(3.5);
    });

    it("increment() on a non-numeric field replaces it with the operand", async () => {
      const col = freshCol("incrementnonnum");
      await col.doc("d").set({ n: "not-a-number" });
      await col.doc("d").update({ n: FieldValue.increment(7) });
      expect((await col.doc("d").get()).get("n")).toBe(7);
    });

    it("arrayUnion() creates the array on an absent field and dedups elements", async () => {
      const col = freshCol("arrayunion");
      await col.doc("d").set({ other: 1 });
      await col.doc("d").update({ tags: FieldValue.arrayUnion("a", "b") });
      expect((await col.doc("d").get()).get("tags")).toEqual(["a", "b"]);
      // "b" already present; "c" repeated within the call is added once.
      await col.doc("d").update({ tags: FieldValue.arrayUnion("b", "c", "c") });
      expect((await col.doc("d").get()).get("tags")).toEqual(["a", "b", "c"]);
    });

    it("arrayUnion() dedups object elements by deep value equality", async () => {
      const col = freshCol("arrayunionobj");
      await col.doc("d").set({ list: [{ x: 1 }] });
      await col.doc("d").update({ list: FieldValue.arrayUnion({ x: 1 }, { x: 2 }) });
      expect((await col.doc("d").get()).get("list")).toEqual([{ x: 1 }, { x: 2 }]);
    });

    it("arrayRemove() removes all occurrences and yields [] on an absent field", async () => {
      const col = freshCol("arrayremove");
      await col.doc("d").set({ list: [1, 2, 1, 3, { x: 1 }] });
      await col.doc("d").update({ list: FieldValue.arrayRemove(1, { x: 1 }) });
      expect((await col.doc("d").get()).get("list")).toEqual([2, 3]);
      await col.doc("d").update({ absent: FieldValue.arrayRemove("z") });
      expect((await col.doc("d").get()).get("absent")).toEqual([]);
    });

    it("FieldValue.delete() removes top-level and dot-path fields; no-op on missing field", async () => {
      const col = freshCol("fvdelete");
      await col.doc("d").set({ drop: 1, m: { drop: 2, keep: 3 }, keep: 4 });
      await col.doc("d").update({
        drop: FieldValue.delete(),
        "m.drop": FieldValue.delete(),
        ghost: FieldValue.delete(),
      });
      const snap = await col.doc("d").get();
      expect(snap.data()).toEqual({ m: { keep: 3 }, keep: 4 });
    });

    // ------------------------------------------------------------------
    // Timestamp fidelity
    // ------------------------------------------------------------------

    it("Timestamp round-trips with exact seconds/nanoseconds (microsecond-aligned)", async () => {
      const col = freshCol("tsroundtrip");
      const ts = new Timestamp(1712345678, 987654000); // nanos aligned to µs — Firestore precision
      await col.doc("d").set({ ts });
      const back = (await col.doc("d").get()).get("ts");
      expect(back).toBeInstanceOf(Timestamp);
      expect(back.seconds).toBe(1712345678);
      expect(back.nanoseconds).toBe(987654000);
      expect(back.isEqual(ts)).toBe(true);
      expect(back.toDate().toISOString()).toBe(ts.toDate().toISOString());
    });

    it("JS Date values are stored and read back as Timestamp with equal millis", async () => {
      const col = freshCol("date");
      const when = new Date("2026-01-02T03:04:05.678Z");
      await col.doc("d").set({ when, nested: { when } });
      const snap = await col.doc("d").get();
      expect(snap.get("when")).toBeInstanceOf(Timestamp);
      expect(snap.get("when").toMillis()).toBe(when.getTime());
      expect(snap.get("nested.when")).toBeInstanceOf(Timestamp);
      expect(snap.get("nested.when").toMillis()).toBe(when.getTime());
    });

    // ------------------------------------------------------------------
    // Queries: where
    // ------------------------------------------------------------------

    it("where == matches strings, numbers and booleans exactly", async () => {
      const col = freshCol("eq");
      await seed(col, {
        a: { s: "x", n: 1, b: true },
        b: { s: "x", n: 2, b: false },
        c: { s: "y", n: 1, b: true },
      });
      expect(idsOf(await col.where("s", "==", "x").get()).sort()).toEqual(["a", "b"]);
      expect(idsOf(await col.where("n", "==", 1).get()).sort()).toEqual(["a", "c"]);
      expect(idsOf(await col.where("b", "==", true).get()).sort()).toEqual(["a", "c"]);
      expect(idsOf(await col.where("s", "==", "zzz").get())).toEqual([]);
    });

    it("where == null matches explicit null but NOT missing fields", async () => {
      const col = freshCol("eqnull");
      await seed(col, {
        explicitNull: { f: null },
        hasValue: { f: 1 },
        missing: { other: 1 },
      });
      expect(idsOf(await col.where("f", "==", null).get())).toEqual(["explicitNull"]);
    });

    it("where == works on nested dot-path fields", async () => {
      const col = freshCol("eqnested");
      await seed(col, {
        a: { m: { k: "hit" } },
        b: { m: { k: "miss" } },
        c: { m: {} },
      });
      expect(idsOf(await col.where("m.k", "==", "hit").get())).toEqual(["a"]);
    });

    it("where == matches Timestamp values exactly", async () => {
      const col = freshCol("eqts");
      const t1 = new Timestamp(1700000000, 0);
      const t2 = new Timestamp(1700000001, 0);
      await seed(col, { a: { t: t1 }, b: { t: t2 } });
      expect(idsOf(await col.where("t", "==", t1).get())).toEqual(["a"]);
    });

    it("where != matches other values and excludes docs missing the field", async () => {
      const col = freshCol("neq");
      await seed(col, {
        one: { f: 1 },
        two: { f: 2 },
        three: { f: 3 },
        missing: { other: true },
      });
      expect(idsOf(await col.where("f", "!=", 1).get()).sort()).toEqual(["three", "two"]);
    });

    it("range filters (>, >=, <, <=) on numbers exclude docs missing the field", async () => {
      const col = freshCol("range");
      await seed(col, {
        n1: { n: 1 },
        n2: { n: 2 },
        n3: { n: 3 },
        missing: { other: true },
      });
      expect(idsOf(await col.where("n", ">", 1).get()).sort()).toEqual(["n2", "n3"]);
      expect(idsOf(await col.where("n", ">=", 2).get()).sort()).toEqual(["n2", "n3"]);
      expect(idsOf(await col.where("n", "<", 3).get()).sort()).toEqual(["n1", "n2"]);
      expect(idsOf(await col.where("n", "<=", 2).get()).sort()).toEqual(["n1", "n2"]);
      expect(idsOf(await col.where("n", ">", 3).get())).toEqual([]);
    });

    it("range filters compare strings lexicographically", async () => {
      const col = freshCol("rangestr");
      await seed(col, {
        apple: { s: "apple" },
        banana: { s: "banana" },
        cherry: { s: "cherry" },
      });
      expect(idsOf(await col.where("s", ">", "apple").get()).sort()).toEqual(["banana", "cherry"]);
      expect(idsOf(await col.where("s", "<=", "banana").get()).sort()).toEqual(["apple", "banana"]);
    });

    it("range filters compare Timestamps chronologically (incl. Date operands)", async () => {
      const col = freshCol("rangets");
      await seed(col, {
        early: { t: new Timestamp(1700000000, 0) },
        mid: { t: new Timestamp(1700000500, 0) },
        late: { t: new Timestamp(1700001000, 0) },
      });
      const cutoff = new Timestamp(1700000500, 0);
      expect(idsOf(await col.where("t", ">=", cutoff).get()).sort()).toEqual(["late", "mid"]);
      expect(idsOf(await col.where("t", "<", new Date(1700000500 * 1000)).get())).toEqual(["early"]);
    });

    it("array-contains matches scalar and object elements", async () => {
      const col = freshCol("arrcontains");
      await seed(col, {
        a: { tags: ["red", "blue"], objs: [{ k: 1 }] },
        b: { tags: ["blue"], objs: [{ k: 2 }] },
        c: { tags: "red" }, // not an array — must not match
      });
      expect(idsOf(await col.where("tags", "array-contains", "red").get())).toEqual(["a"]);
      expect(idsOf(await col.where("tags", "array-contains", "blue").get()).sort()).toEqual(["a", "b"]);
      expect(idsOf(await col.where("objs", "array-contains", { k: 2 }).get())).toEqual(["b"]);
    });

    it("array-contains-any matches docs whose array intersects the given values", async () => {
      const col = freshCol("arrcontainsany");
      await seed(col, {
        a: { tags: ["red", "blue"] },
        b: { tags: ["green"] },
        c: { tags: ["yellow"] },
        d: { other: true },
      });
      expect(idsOf(await col.where("tags", "array-contains-any", ["blue", "green"]).get()).sort()).toEqual([
        "a",
        "b",
      ]);
      expect(idsOf(await col.where("tags", "array-contains-any", ["nope"]).get())).toEqual([]);
    });

    it("in matches membership, including at the 30-value maximum", async () => {
      const col = freshCol("in");
      await seed(col, {
        five: { n: 5 },
        thirty: { n: 30 },
        fifty: { n: 50 },
        missing: { other: true },
      });
      expect(idsOf(await col.where("n", "in", [5, 50]).get()).sort()).toEqual(["fifty", "five"]);
      const thirtyValues = Array.from({ length: 30 }, (_, i) => i + 1); // 1..30
      expect(idsOf(await col.where("n", "in", thirtyValues).get()).sort()).toEqual(["five", "thirty"]);
    });

    it('where("__name__", "in", ids) selects documents by ID (learnBillingCycle.ts computeInvoiceDelays shape)', async () => {
      const col = freshCol("nameid");
      await seed(col, { a: { n: 1 }, b: { n: 2 }, c: { n: 3 } });
      const snap = await col.where("__name__", "in", ["a", "c", "ghost"]).get();
      expect(idsOf(snap).sort()).toEqual(["a", "c"]);
      expect(snap.docs.map((doc: any) => doc.get("n")).sort()).toEqual([1, 3]);
    });

    it("not-in excludes listed values and docs missing the field", async () => {
      const col = freshCol("notin");
      await seed(col, {
        one: { f: 1 },
        two: { f: 2 },
        three: { f: 3 },
        missing: { other: true },
      });
      expect(idsOf(await col.where("f", "not-in", [1, 3]).get())).toEqual(["two"]);
    });

    it("chained where() clauses combine with AND", async () => {
      const col = freshCol("and");
      await seed(col, {
        a: { kind: "x", n: 1 },
        b: { kind: "x", n: 5 },
        c: { kind: "y", n: 5 },
      });
      expect(idsOf(await col.where("kind", "==", "x").where("n", ">", 2).get())).toEqual(["b"]);
    });

    // ------------------------------------------------------------------
    // Queries: orderBy / limit / offset
    // ------------------------------------------------------------------

    it("orderBy asc/desc sorts numbers, strings and Timestamps", async () => {
      const col = freshCol("orderby");
      await seed(col, {
        a: { n: 2, s: "bb", t: new Timestamp(200, 0) },
        b: { n: 1, s: "cc", t: new Timestamp(100, 0) },
        c: { n: 3, s: "aa", t: new Timestamp(300, 0) },
      });
      expect(idsOf(await col.orderBy("n").get())).toEqual(["b", "a", "c"]);
      expect(idsOf(await col.orderBy("n", "desc").get())).toEqual(["c", "a", "b"]);
      expect(idsOf(await col.orderBy("s").get())).toEqual(["c", "a", "b"]);
      expect(idsOf(await col.orderBy("t", "desc").get())).toEqual(["c", "a", "b"]);
    });

    it("multiple orderBy clauses sort by primary then secondary field", async () => {
      const col = freshCol("orderby2");
      await seed(col, {
        a: { g: 1, n: 2 },
        b: { g: 1, n: 1 },
        c: { g: 0, n: 9 },
      });
      expect(idsOf(await col.orderBy("g").orderBy("n").get())).toEqual(["c", "b", "a"]);
      expect(idsOf(await col.orderBy("g", "desc").orderBy("n", "desc").get())).toEqual(["a", "b", "c"]);
    });

    it("limit() and offset() page through an ordered query", async () => {
      const col = freshCol("limit");
      await seed(col, {
        a: { n: 1 },
        b: { n: 2 },
        c: { n: 3 },
        d: { n: 4 },
      });
      expect(idsOf(await col.orderBy("n").limit(2).get())).toEqual(["a", "b"]);
      expect(idsOf(await col.orderBy("n").offset(1).limit(2).get())).toEqual(["b", "c"]);
      expect(idsOf(await col.orderBy("n").offset(3).get())).toEqual(["d"]);
      expect(idsOf(await col.orderBy("n", "desc").limit(1).get())).toEqual(["d"]);
    });

    it("range filter combined with orderBy on the same field", async () => {
      const col = freshCol("wherorder");
      await seed(col, {
        a: { n: 10 },
        b: { n: 20 },
        c: { n: 30 },
        d: { n: 40 },
      });
      expect(idsOf(await col.where("n", ">", 10).orderBy("n", "desc").limit(2).get())).toEqual(["d", "c"]);
    });

    it("orderBy on a field some docs lack", async () => {
      const col = freshCol("orderbymissing");
      await seed(col, {
        a: { n: 1 },
        b: { n: 2 },
        noField: { other: true },
      });
      const ids = idsOf(await col.orderBy("n").get());
      if (name === "shim") {
        // KNOWN DIVERGENCE: real Firestore EXCLUDES docs missing the orderBy
        // field; the shim includes them, sorted first (treated as -Infinity).
        expect(ids).toEqual(["noField", "a", "b"]);
      } else {
        expect(ids).toEqual(["a", "b"]);
      }
    });

    it("empty query result: empty=true, size=0, docs=[], forEach never called", async () => {
      const col = freshCol("empty");
      const snap = await col.where("nothing", "==", "matches").get();
      expect(snap.empty).toBe(true);
      expect(snap.size).toBe(0);
      expect(snap.docs).toEqual([]);
      let called = 0;
      snap.forEach(() => called++);
      expect(called).toBe(0);
    });

    it("forEach() visits every doc of a non-empty snapshot in order", async () => {
      const col = freshCol("foreach");
      await seed(col, { a: { n: 1 }, b: { n: 2 } });
      const seen: string[] = [];
      (await col.orderBy("n").get()).forEach((doc: any) => seen.push(`${doc.id}:${doc.get("n")}`));
      expect(seen).toEqual(["a:1", "b:2"]);
    });

    it("count() aggregates matching docs without fetching them", async () => {
      const col = freshCol("count");
      await seed(col, { a: { n: 1 }, b: { n: 2 }, c: { n: 3 } });
      expect((await col.count().get()).data().count).toBe(3);
      expect((await col.where("n", ">", 1).count().get()).data().count).toBe(2);
      expect((await col.where("n", ">", 99).count().get()).data().count).toBe(0);
    });

    it("select() projection returns the same matching docs", async () => {
      const col = freshCol("select");
      await seed(col, { a: { keep: 1, drop: "x" }, b: { keep: 2, drop: "y" } });
      const snap = await col.orderBy("keep").select("keep").get();
      expect(idsOf(snap)).toEqual(["a", "b"]);
      if (name === "shim") {
        // KNOWN DIVERGENCE: the shim ignores the projection and returns full
        // documents; real Firestore returns only the selected fields. The app
        // only ever reads the selected fields, so full docs are a superset.
        expect(snap.docs[0].data()).toEqual({ keep: 1, drop: "x" });
      } else {
        expect(snap.docs[0].data()).toEqual({ keep: 1 });
      }
      // The selected field itself is identical on both backends.
      expect(snap.docs.map((doc: any) => doc.get("keep"))).toEqual([1, 2]);
    });

    // ------------------------------------------------------------------
    // collectionGroup / subcollections / listDocuments / getAll
    // ------------------------------------------------------------------

    it("subcollections read/write under a document path", async () => {
      const col = freshCol("subcol");
      const parent = col.doc("p1");
      await parent.set({ isParent: true });
      await parent.collection("children").doc("c1").set({ n: 1 });
      const snap = await parent.collection("children").doc("c1").get();
      expect(snap.data()).toEqual({ n: 1 });
      // Subcollection docs do not appear in the parent collection query.
      expect(idsOf(await col.get())).toEqual(["p1"]);
    });

    it("collectionGroup() matches top-level and nested collections with the ID, supports where", async () => {
      const groupId = `items${RUN}g${seq++}`;
      const parents = freshCol("cgparents");
      await parents.doc("p1").set({ parent: true });
      await parents.doc("p1").collection(groupId).doc("nested1").set({ n: 1 });
      await parents.doc("p2").collection(groupId).doc("nested2").set({ n: 2 });
      await db.collection(groupId).doc("top1").set({ n: 3 });

      const all = await db.collectionGroup(groupId).get();
      expect(idsOf(all).sort()).toEqual(["nested1", "nested2", "top1"]);
      const filtered = await db.collectionGroup(groupId).where("n", ">", 1).get();
      expect(idsOf(filtered).sort()).toEqual(["nested2", "top1"]);
      // Ref paths point at the real locations.
      const paths = all.docs.map((doc: any) => doc.ref.path).sort();
      expect(paths).toEqual(
        [
          `${parents.path}/p1/${groupId}/nested1`,
          `${parents.path}/p2/${groupId}/nested2`,
          `${groupId}/top1`,
        ].sort(),
      );
    });

    it("collectionGroup() rejects slash-containing ids", () => {
      expect(() => db.collectionGroup("a/b")).toThrow();
    });

    it("listDocuments() returns refs for the collection's documents", async () => {
      const col = freshCol("listdocs");
      await seed(col, { a: { n: 1 }, b: { n: 2 } });
      const refs = await col.listDocuments();
      expect(refs.map((r: any) => r.id).sort()).toEqual(["a", "b"]);
      expect(refs.map((r: any) => r.path).sort()).toEqual([`${col.path}/a`, `${col.path}/b`]);
    });

    it("getAll() returns snapshots in argument order, including missing docs", async () => {
      const col = freshCol("getall");
      await seed(col, { a: { n: 1 }, b: { n: 2 } });
      const snaps = await db.getAll(col.doc("b"), col.doc("ghost"), col.doc("a"));
      expect(snaps.map((s: any) => s.id)).toEqual(["b", "ghost", "a"]);
      expect(snaps.map((s: any) => s.exists)).toEqual([true, false, true]);
      expect(snaps[0].data()).toEqual({ n: 2 });
      expect(snaps[1].data()).toBeUndefined();
    });

    // ------------------------------------------------------------------
    // Batches / transactions / recursiveDelete
    // ------------------------------------------------------------------

    it("batch() applies set/update/delete together on commit", async () => {
      const col = freshCol("batch");
      await seed(col, { upd: { n: 1 }, del: { n: 2 } });
      const batch = db.batch();
      batch.set(col.doc("new"), { n: 10 });
      batch.set(col.doc("merged"), { a: 1 });
      batch.set(col.doc("merged"), { b: 2 }, { merge: true });
      batch.update(col.doc("upd"), { n: 99, at: FieldValue.serverTimestamp() });
      batch.delete(col.doc("del"));
      await batch.commit();

      expect((await col.doc("new").get()).data()).toEqual({ n: 10 });
      expect((await col.doc("merged").get()).data()).toEqual({ a: 1, b: 2 });
      const upd = await col.doc("upd").get();
      expect(upd.get("n")).toBe(99);
      expect(upd.get("at")).toBeInstanceOf(Timestamp);
      expect((await col.doc("del").get()).exists).toBe(false);
    });

    it("runTransaction() reads then writes and returns the callback's value", async () => {
      const col = freshCol("txn");
      await col.doc("counter").set({ n: 10 });
      const result = await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(col.doc("counter"));
        const next = (snap.get("n") as number) + 5;
        tx.update(col.doc("counter"), { n: next });
        tx.set(col.doc("audit"), { wrote: next });
        return next;
      });
      expect(result).toBe(15);
      expect((await col.doc("counter").get()).get("n")).toBe(15);
      expect((await col.doc("audit").get()).data()).toEqual({ wrote: 15 });
    });

    it("runTransaction() supports tx.get(query) and tx.delete()", async () => {
      const col = freshCol("txnquery");
      await seed(col, { a: { n: 1 }, b: { n: 2 }, c: { n: 3 } });
      const seenIds = await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(col.where("n", ">", 1));
        for (const doc of snap.docs) tx.delete(doc.ref);
        return idsOf(snap).sort();
      });
      expect(seenIds).toEqual(["b", "c"]);
      expect(idsOf(await col.get())).toEqual(["a"]);
    });

    it("runTransaction() rejects (and applies nothing) when the callback throws", async () => {
      const col = freshCol("txnabort");
      await col.doc("d").set({ n: 1 });
      await expect(
        db.runTransaction(async (tx: any) => {
          tx.update(col.doc("d"), { n: 999 });
          throw new Error("abort!");
        }),
      ).rejects.toThrow("abort!");
      expect((await col.doc("d").get()).get("n")).toBe(1);
    });

    // Mirrors both app call sites (tools/handlers.ts:228,
    // precisionSearchQueue.ts:1953): equality filter + orderBy("date","desc")
    // + limit, cursor doc re-fetched by id and passed as a snapshot.
    it("startAfter(docSnapshot) resumes an orderBy-desc page (tools/handlers.ts:228, precisionSearchQueue.ts:1953 shape)", async () => {
      const col = freshCol("cursor");
      const t = (iso: string) => Timestamp.fromDate(new Date(iso));
      await seed(col, {
        a: { userId: "u1", date: t("2026-01-04T00:00:00Z") },
        b: { userId: "u1", date: t("2026-01-03T00:00:00Z") },
        c: { userId: "u1", date: t("2026-01-02T00:00:00Z") },
        d: { userId: "u1", date: t("2026-01-01T00:00:00Z") },
        x: { userId: "u2", date: t("2026-01-05T00:00:00Z") },
      });
      const base = col.where("userId", "==", "u1").orderBy("date", "desc");
      const page1 = await base.limit(2).get();
      expect(page1.docs.map((doc: any) => doc.id)).toEqual(["a", "b"]);

      const cursorSnap = await col.doc(page1.docs[1].id).get();
      const page2 = await base.limit(2).startAfter(cursorSnap).get();
      expect(page2.docs.map((doc: any) => doc.id)).toEqual(["c", "d"]);
    });

    // The app never calls .settings(), so firebase-admin's default rejection
    // of undefined values applies to every write path with an optional TS
    // field — and the shim now mirrors it.
    it("set() containing an undefined property value rejects and writes nothing", async () => {
      const col = freshCol("undefset");
      const attempt = async () => col.doc("d").set({ a: 1, b: undefined });
      await expect(attempt()).rejects.toThrow(/undefined/i);
      expect((await col.doc("d").get()).exists).toBe(false);
    });

    it("update() containing an undefined property value rejects and changes nothing", async () => {
      const col = freshCol("undefupd");
      await col.doc("d").set({ a: 1 });
      const attempt = async () => col.doc("d").update({ b: undefined });
      await expect(attempt()).rejects.toThrow(/undefined/i);
      expect((await col.doc("d").get()).data()).toEqual({ a: 1 });
    });

    it("recursiveDelete(docRef) removes the doc and its subcollections, sparing siblings", async () => {
      const col = freshCol("recursive");
      await col.doc("target").set({ n: 1 });
      await col.doc("target").collection("sub").doc("s1").set({ n: 2 });
      await col.doc("target").collection("sub").doc("s2").set({ n: 3 });
      await col.doc("sibling").set({ n: 4 });
      await db.recursiveDelete(col.doc("target"));
      expect((await col.doc("target").get()).exists).toBe(false);
      expect((await col.doc("target").collection("sub").get()).size).toBe(0);
      expect((await col.doc("sibling").get()).data()).toEqual({ n: 4 });
    });
  });
}

// ---------------------------------------------------------------------------
// Backend wiring
// ---------------------------------------------------------------------------

runParitySuite("shim", async () => {
  // Force the embedded PGlite backend — never a real Postgres.
  delete process.env.DATABASE_URL;
  const shim = await import("../selfhost/firestore-shim");
  return { db: shim.getFirestore(), FieldValue: shim.FieldValue, Timestamp: shim.Timestamp };
});

runParitySuite(
  "firebase-admin",
  async () => {
    const { initializeApp, getApps } = await import("firebase-admin/app");
    const adminFirestore = await import("firebase-admin/firestore");
    if (getApps().length === 0) {
      initializeApp({ projectId: "demo-fibuki" });
    }
    return {
      db: adminFirestore.getFirestore(),
      FieldValue: adminFirestore.FieldValue,
      Timestamp: adminFirestore.Timestamp,
    };
  },
  // Only meaningful against the Firestore emulator; hard-skip otherwise so the
  // default suite stays green without any emulator running.
  { skip: !process.env.FIRESTORE_EMULATOR_HOST },
);
