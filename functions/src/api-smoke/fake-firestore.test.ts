/**
 * Harness self-test for the in-memory Firestore double the C1 route suite runs
 * on. Pure module (no next/firebase-admin), so unlike route-owner-scoping.test.ts
 * it runs locally under the api-smoke profile:
 *
 *   npx vitest run --config vitest.api-smoke.config.ts \
 *     src/api-smoke/fake-firestore.test.ts --pool=forks --maxWorkers=1
 *
 * If the double's query/patch semantics drift from Firestore, the route tests'
 * owner-scoping assertions would silently pass on a broken harness — this pins
 * the harness so those assertions mean what they claim.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeFirestore } from "./fake-firestore";

const ts = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) });
const DELETE = { __sentinel: "delete" as const };
const SERVER_TS = { __sentinel: "serverTimestamp" as const };

describe("FakeFirestore — documents", () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = new FakeFirestore();
  });

  it("returns exists:false for a missing doc", async () => {
    const snap = await db.collection("sources").doc("nope").get();
    expect(snap.exists).toBe(false);
    expect(snap.data()).toBeUndefined();
  });

  it("reads a seeded doc back", async () => {
    db.seed("sources", "s1", { userId: "A", type: "csv" });
    const snap = await db.collection("sources").doc("s1").get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ userId: "A", type: "csv" });
  });

  it("data() returns a copy, not a live reference", async () => {
    db.seed("sources", "s1", { userId: "A" });
    const snap = await db.collection("sources").doc("s1").get();
    (snap.data() as Record<string, unknown>).userId = "MUTATED";
    const again = await db.collection("sources").doc("s1").get();
    expect(again.data()).toEqual({ userId: "A" });
  });

  it("update merges fields and honours delete/serverTimestamp sentinels", async () => {
    db.seed("sources", "s1", { userId: "A", type: "api", apiConfig: { x: 1 } });
    await db.collection("sources").doc("s1").update({
      type: "csv",
      apiConfig: DELETE,
      updatedAt: SERVER_TS,
    });
    const data = (await db.collection("sources").doc("s1").get()).data()!;
    expect(data.type).toBe("csv");
    expect(data.userId).toBe("A");
    expect("apiConfig" in data).toBe(false);
    expect(data.updatedAt).toBeDefined();
  });

  it("throws when updating a missing doc (Admin SDK behaviour)", async () => {
    await expect(db.collection("x").doc("missing").update({ a: 1 })).rejects.toThrow(
      /No document to update/
    );
  });

  it("delete removes a doc", async () => {
    db.seed("x", "d1", { a: 1 });
    await db.collection("x").doc("d1").delete();
    expect((await db.collection("x").doc("d1").get()).exists).toBe(false);
  });

  it("add assigns an id and stores the doc", async () => {
    const ref = await db.collection("queue").add({ status: "pending" });
    expect(ref.id).toBeTruthy();
    expect((await db.collection("queue").doc(ref.id).get()).data()).toEqual({ status: "pending" });
  });
});

describe("FakeFirestore — queries", () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = new FakeFirestore();
    db.seed("q", "1", { userId: "A", status: "pending", createdAt: ts(100) });
    db.seed("q", "2", { userId: "A", status: "processing", createdAt: ts(200) });
    db.seed("q", "3", { userId: "B", status: "completed", createdAt: ts(300) });
    db.seed("q", "4", { userId: "A", status: "completed", createdAt: ts(400) });
  });

  it("filters on ==", async () => {
    const res = await db.collection("q").where("userId", "==", "A").get();
    expect(res.size).toBe(3);
    expect(res.docs.map((d) => d.id).sort()).toEqual(["1", "2", "4"]);
  });

  it("filters on in", async () => {
    const res = await db.collection("q").where("status", "in", ["pending", "processing"]).get();
    expect(res.docs.map((d) => d.id).sort()).toEqual(["1", "2"]);
  });

  it("chains where clauses (AND)", async () => {
    const res = await db
      .collection("q")
      .where("userId", "==", "A")
      .where("status", "in", ["completed"])
      .get();
    expect(res.docs.map((d) => d.id)).toEqual(["4"]);
  });

  it("orderBy desc + limit picks the newest", async () => {
    const res = await db
      .collection("q")
      .where("userId", "==", "A")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    expect(res.size).toBe(1);
    expect(res.docs[0].id).toBe("4");
  });

  it("orderBy asc + limit picks the oldest", async () => {
    const res = await db.collection("q").where("userId", "==", "A").orderBy("createdAt", "asc").limit(1).get();
    expect(res.docs[0].id).toBe("1");
  });

  it("reports empty for a no-match query", async () => {
    const res = await db.collection("q").where("userId", "==", "ZZ").get();
    expect(res.empty).toBe(true);
    expect(res.size).toBe(0);
  });

  it("forEach visits every matched doc", async () => {
    const ids: string[] = [];
    const res = await db.collection("q").where("userId", "==", "A").get();
    res.forEach((d) => ids.push(d.id));
    expect(ids.sort()).toEqual(["1", "2", "4"]);
  });
});

describe("FakeFirestore — batch + snapshot refs", () => {
  it("batch delete removes the docs a query returned", async () => {
    const db = new FakeFirestore();
    db.seed("transactions", "t1", { sourceId: "s1" });
    db.seed("transactions", "t2", { sourceId: "s1" });
    db.seed("transactions", "t3", { sourceId: "s2" });

    const q = await db.collection("transactions").where("sourceId", "==", "s1").get();
    const batch = db.batch();
    for (const doc of q.docs) batch.delete(doc.ref);
    await batch.commit();

    expect((await db.collection("transactions").where("sourceId", "==", "s1").get()).empty).toBe(true);
    expect((await db.collection("transactions").doc("t3").get()).exists).toBe(true);
  });

  it("a snapshot ref can update its own doc", async () => {
    const db = new FakeFirestore();
    db.seed("q", "1", { status: "pending" });
    const q = await db.collection("q").where("status", "==", "pending").get();
    await q.docs[0].ref.update({ status: "paused" });
    expect((await db.collection("q").doc("1").get()).data()!.status).toBe("paused");
  });

  it("reset clears everything", async () => {
    const db = new FakeFirestore();
    db.seed("q", "1", { a: 1 });
    db.reset();
    expect((await db.collection("q").doc("1").get()).exists).toBe(false);
  });
});
