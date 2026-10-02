/**
 * set(..., { merge: true }) resolves top-level transforms against the stored
 * document, as Firestore does. It used to resolve them against nothing, so a
 * counter written that way (usage, billing, matching stats) never got past 1.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, FieldValue, Timestamp, __resetFirestoreShim } from "./firestore-shim";

const db = getFirestore();
beforeEach(() => __resetFirestoreShim());

describe("set with merge and transforms", () => {
  it("increment adds to the stored value", async () => {
    const r = db.doc("config/counter");
    await r.set({ n: FieldValue.increment(1) }, { merge: true });
    await r.set({ n: FieldValue.increment(1) }, { merge: true });
    await r.set({ n: FieldValue.increment(5), other: "x" }, { merge: true });
    expect((await r.get()).data()).toEqual({ n: 7, other: "x" });
  });

  it("arrayUnion and arrayRemove apply to the stored array; other keys survive", async () => {
    const r = db.doc("config/arr");
    await r.set({ tags: ["a"], keep: 1 });
    await r.set({ tags: FieldValue.arrayUnion("b", "a") }, { merge: true });
    expect((await r.get()).data()).toEqual({ tags: ["a", "b"], keep: 1 });
    await r.set({ tags: FieldValue.arrayRemove("a") }, { merge: true });
    expect((await r.get()).data()).toEqual({ tags: ["b"], keep: 1 });
  });

  it("serverTimestamp and delete still work, and a plain set still replaces", async () => {
    const r = db.doc("config/ts");
    await r.set({ a: 1, b: 2 });
    await r.set({ at: FieldValue.serverTimestamp(), b: FieldValue.delete() }, { merge: true });
    const d = (await r.get()).data()!;
    expect(d.a).toBe(1);
    expect(d.b).toBeUndefined();
    expect(d.at).toBeInstanceOf(Timestamp);
    await r.set({ n: FieldValue.increment(3) });
    expect((await r.get()).data()).toEqual({ n: 3 });
  });
});
