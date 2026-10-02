/**
 * runTransaction and batches on self-host are isolated and atomic, like
 * Firestore's. They used to read and write with no isolation, one write
 * after another: concurrent callers lost updates, single-use records could
 * be used twice, and a failure halfway left half the writes behind.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, FieldValue, __resetFirestoreShim } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { allocateInvoiceNumber } from "../invoicing/numberAllocator";
import { createOAuthState, consumeOAuthState } from "../../../lib/gmail/oauth-state";

const db = getFirestore();
beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
});

/**
 * A barrier: resolves for everyone once `count` callers have arrived. Used so
 * every transaction has READ before any of them writes, the interleaving that
 * loses updates, guaranteed instead of hoped for with a delay.
 */
function barrier(count: number): () => Promise<void> {
  let waiting: Array<() => void> = [];
  return () =>
    new Promise<void>((release) => {
      waiting.push(release);
      if (waiting.length === count) {
        const all = waiting;
        waiting = [];
        all.forEach((r) => r());
      }
    });
}

/** Read, wait for every other caller to have read too, write. */
async function incrementInTx(path: string, allHaveRead: () => Promise<void>): Promise<void> {
  let first = true;
  await db.runTransaction(async (tx) => {
    const snap = (await tx.get(db.doc(path))) as { data(): { n?: number } | undefined };
    const n = snap.data()?.n ?? 0;
    if (first) {
      first = false; // only the first attempt waits: retries run as they come
      await allHaveRead();
    }
    tx.set(db.doc(path), { n: n + 1 });
  });
}

describe("isolation", () => {
  it("concurrent read-modify-write transactions lose no update", async () => {
    const allHaveRead = barrier(6);
    await Promise.all(Array.from({ length: 6 }, () => incrementInTx("config/counter", allHaveRead)));
    expect((await db.doc("config/counter").get()).data()).toEqual({ n: 6 });
  });

  it("invoice numbers issued at the same moment are all different", async () => {
    const numbers = await Promise.all(Array.from({ length: 5 }, () => allocateInvoiceNumber(db as never, "u1")));
    expect(new Set(numbers).size).toBe(5);
  });

  it("a single-use OAuth state is used exactly once, even in parallel", async () => {
    const state = await createOAuthState("user-a", "gmail");
    const results = await Promise.all(Array.from({ length: 4 }, () => consumeOAuthState(state, "gmail")));
    expect(results.filter((r) => r === "user-a")).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(3);
  });

  it("a plain write landing between a transaction's read and commit makes it run again", async () => {
    await db.doc("config/c").set({ n: 1 });
    let runs = 0;
    await db.runTransaction(async (tx) => {
      runs++;
      const snap = (await tx.get(db.doc("config/c"))) as { data(): { n: number } };
      if (runs === 1) await db.doc("config/c").set({ n: 100 }); // someone else, mid-flight
      tx.set(db.doc("config/c"), { n: snap.data().n + 1 });
    });
    expect(runs).toBe(2);
    expect((await db.doc("config/c").get()).data()).toEqual({ n: 101 });
  });

  it("a document newly matching a query read in the transaction makes it run again", async () => {
    await db.doc("jobs/a").set({ status: "pending" });
    let runs = 0;
    await db.runTransaction(async (tx) => {
      runs++;
      const pending = (await tx.get(db.collection("jobs").where("status", "==", "pending"))) as {
        size: number;
      };
      if (runs === 1) await db.doc("jobs/b").set({ status: "pending" });
      tx.set(db.doc("config/jobCount"), { pending: pending.size });
    });
    expect(runs).toBe(2);
    expect((await db.doc("config/jobCount").get()).data()).toEqual({ pending: 2 });
  });
});

describe("atomicity", () => {
  it("a transaction whose callback throws writes nothing", async () => {
    await expect(
      db.runTransaction(async (tx) => {
        tx.set(db.doc("config/x"), { written: true });
        throw new Error("changed my mind");
      }),
    ).rejects.toThrow("changed my mind");
    expect((await db.doc("config/x").get()).exists).toBe(false);
  });

  it("a transaction failing on its second write leaves the first unwritten", async () => {
    await expect(
      db.runTransaction(async (tx) => {
        tx.set(db.doc("config/first"), { ok: true });
        tx.update(db.doc("config/missing"), { ok: true }); // update on a missing doc fails at commit
      }),
    ).rejects.toThrow();
    expect((await db.doc("config/first").get()).exists).toBe(false);
  });

  it("a batch is all or nothing", async () => {
    const batch = db.batch();
    batch.set(db.doc("config/b1"), { ok: true });
    batch.update(db.doc("config/nope"), { ok: true });
    await expect(batch.commit()).rejects.toThrow();
    expect((await db.doc("config/b1").get()).exists).toBe(false);
  });

  it("writes in one transaction see each other in order, transforms included", async () => {
    await db.runTransaction(async (tx) => {
      tx.set(db.doc("config/seq"), { n: 1 });
      tx.update(db.doc("config/seq"), { n: FieldValue.increment(2), tag: "x" });
    });
    expect((await db.doc("config/seq").get()).data()).toEqual({ n: 3, tag: "x" });
  });

  it("reads after writes are refused, as firebase-admin does", async () => {
    await expect(
      db.runTransaction(async (tx) => {
        tx.set(db.doc("config/w"), { a: 1 });
        await tx.get(db.doc("config/w"));
      }),
    ).rejects.toThrow(/reads to be executed before all writes/);
  });
});
