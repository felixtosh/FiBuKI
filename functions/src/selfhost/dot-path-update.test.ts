/**
 * Characterization of the dot-path update walk (`deepSet` / `deepDelete` in
 * firestore-shim). These are the observable contracts that must survive the
 * rewrite of that walk from in-place mutation to rebuild-on-the-way-out
 * (CodeQL #279/#280/#281, js/remote-property-injection — see the commit).
 *
 * Written against the public update() API on purpose: the helpers are private,
 * and the thing worth pinning is the behaviour, not their shape.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { FieldValue } from "@google-cloud/firestore";

const db = getFirestore();

describe("dot-path updates", () => {
  beforeAll(async () => {
    await __resetFirestoreShim();
  });

  it("writes a nested path and leaves its siblings alone", async () => {
    const ref = db.collection("dotpath").doc("a");
    await ref.set({ a: { keep: 1, deep: { x: 1 } }, top: "untouched" });
    await ref.update({ "a.deep.x": 2 });
    expect((await ref.get()).data()).toEqual({
      a: { keep: 1, deep: { x: 2 } },
      top: "untouched",
    });
  });

  it("creates missing intermediate levels", async () => {
    const ref = db.collection("dotpath").doc("b");
    await ref.set({ present: 1 });
    await ref.update({ "made.up.path": "v" });
    expect((await ref.get()).data()).toEqual({ present: 1, made: { up: { path: "v" } } });
  });

  it("replaces a non-object intermediate rather than writing through it", async () => {
    const ref = db.collection("dotpath").doc("c");
    await ref.set({ scalar: 5, arr: [1, 2] });
    await ref.update({ "scalar.child": 1, "arr.child": 2 });
    expect((await ref.get()).data()).toEqual({ scalar: { child: 1 }, arr: { child: 2 } });
  });

  it("deletes a nested field and keeps the rest of the branch", async () => {
    const ref = db.collection("dotpath").doc("d");
    await ref.set({ a: { gone: 1, stays: 2 }, other: 3 });
    await ref.update({ "a.gone": FieldValue.delete() });
    expect((await ref.get()).data()).toEqual({ a: { stays: 2 }, other: 3 });
  });

  it("deleting a path that does not exist is a no-op", async () => {
    const ref = db.collection("dotpath").doc("e");
    await ref.set({ a: { x: 1 } });
    await ref.update({ "a.missing": FieldValue.delete(), "no.such.branch": FieldValue.delete() });
    expect((await ref.get()).data()).toEqual({ a: { x: 1 } });
  });

  it("an array-index dot-path is a no-op for delete, and replaces the array for a write", async () => {
    // Firestore does not address array elements by dot-path. The delete used
    // to descend into the array and leave a hole, which stored as [null, "b"];
    // it is now a no-op. The write side replaces the array with a map, which is
    // what it always did — pinned because the two sides deliberately differ.
    const ref = db.collection("dotpath").doc("j");
    await ref.set({ tags: ["a", "b"] });
    await ref.update({ "tags.0": FieldValue.delete() });
    expect((await ref.get()).data()).toEqual({ tags: ["a", "b"] });

    await ref.update({ "tags.0": "z" });
    expect((await ref.get()).data()).toEqual({ tags: { "0": "z" } });
  });

  it("increments and array sentinels resolve against the nested current value", async () => {
    const ref = db.collection("dotpath").doc("f");
    await ref.set({ counters: { n: 4 }, tags: { list: ["a"] } });
    await ref.update({
      "counters.n": FieldValue.increment(3),
      "counters.fresh": FieldValue.increment(2),
      "tags.list": FieldValue.arrayUnion("b"),
    });
    expect((await ref.get()).data()).toEqual({
      counters: { n: 7, fresh: 2 },
      tags: { list: ["a", "b"] },
    });
  });

  it("preserves Timestamp values living beside the path being written", async () => {
    const ref = db.collection("dotpath").doc("g");
    const ts = Timestamp.fromMillis(1_700_000_000_000);
    await ref.set({ meta: { at: ts, note: "x" } });
    await ref.update({ "meta.note": "y" });
    const got = (await ref.get()).data() as { meta: { at: Timestamp; note: string } };
    expect(got.meta.note).toBe("y");
    expect(got.meta.at).toBeInstanceOf(Timestamp);
    expect(got.meta.at.toMillis()).toBe(ts.toMillis());
  });

  it("writing THROUGH a Timestamp replaces it with a map, as Firestore does", async () => {
    const ref = db.collection("dotpath").doc("h");
    await ref.set({ at: Timestamp.fromMillis(1_700_000_000_000) });
    await ref.update({ "at.child": 1 });
    expect((await ref.get()).data()).toEqual({ at: { child: 1 } });
  });

  it("refuses prototype-polluting segments anywhere in the path", async () => {
    const ref = db.collection("dotpath").doc("i");
    await ref.set({ ok: 1 });
    await expect(ref.update({ "a.__proto__.polluted": true })).rejects.toThrow(/invalid field name/);
    await expect(ref.update({ "a.constructor": true })).rejects.toThrow(/invalid field name/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((await ref.get()).data()).toEqual({ ok: 1 });
  });
});
