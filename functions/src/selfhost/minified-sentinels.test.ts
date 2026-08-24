/**
 * FieldValue sentinels must survive a MINIFIED build.
 *
 * fibuki-web is a `next build`, which minifies the server bundle and bundles
 * @google-cloud/firestore into it (it is not in serverExternalPackages). Class
 * names do not survive that: in the built container
 * `FieldValue.serverTimestamp().constructor.name` is "u" and
 * NumericIncrementTransform's is "c". The shim used to discriminate sentinels
 * by class name, so every sentinel written from an app/api route went
 * unrecognised and was stored as its own enumerable properties instead:
 * `{}` for serverTimestamp() and delete(), `{operand: n}` for increment(),
 * `{elements: [...]}` for arrayUnion()/arrayRemove().
 *
 * The visible symptom was the dashboard crashing on sign-in with
 * "t.getTime is not a function": worker_activity notifications from
 * app/api/worker/route.ts carried `createdAt: {}`, and the notifications list
 * called .getTime() on it.
 *
 * Nothing in the api container or the test profile minifies, so a name-based
 * check passes every suite while being wrong in production, so these tests
 * reproduce the mangling explicitly rather than trusting the build.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { FieldValue, Timestamp, getFirestore, __resetFirestoreShim } from "./firestore-shim";

/**
 * A sentinel as it arrives inside the minified web bundle: prototype chain
 * intact (so the SDK's own `methodName` getter still answers) with the class
 * name mangled to a single letter.
 */
function asMinified<T extends object>(sentinel: T): T {
  const proto = Object.create(Object.getPrototypeOf(sentinel));
  Object.defineProperty(proto, "constructor", {
    value: { name: "u" },
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return Object.assign(Object.create(proto), sentinel) as T;
}

describe("minified FieldValue sentinels", () => {
  beforeAll(async () => {
    await __resetFirestoreShim();
  });

  it("the mangling this file simulates is real: name gone, methodName intact", () => {
    const st = asMinified(FieldValue.serverTimestamp());
    expect(st.constructor.name).toBe("u");
    expect((st as unknown as { methodName: string }).methodName).toBe("FieldValue.serverTimestamp");
    expect(st instanceof FieldValue).toBe(true);
  });

  it("serverTimestamp() in set() stores a Timestamp, not an empty map", async () => {
    const ref = getFirestore().collection("minified").doc("st");
    await ref.set({
      createdAt: asMinified(FieldValue.serverTimestamp()),
      meta: { at: asMinified(FieldValue.serverTimestamp()) },
    });

    const data = (await ref.get()).data()!;
    expect(data.createdAt).toBeInstanceOf(Timestamp);
    expect((data.meta as { at: Timestamp }).at).toBeInstanceOf(Timestamp);
    // The bug stored `{}`, whose toMillis() does not exist at all.
    expect(Math.abs((data.createdAt as Timestamp).toMillis() - Date.now())).toBeLessThan(10_000);
  });

  it("serverTimestamp() in update() resolves, including on a dot-path", async () => {
    const ref = getFirestore().collection("minified").doc("stu");
    await ref.set({ nested: { keep: 1 } });
    await ref.update({
      touchedAt: asMinified(FieldValue.serverTimestamp()),
      "nested.at": asMinified(FieldValue.serverTimestamp()),
    });

    const data = (await ref.get()).data()!;
    expect(data.touchedAt).toBeInstanceOf(Timestamp);
    expect((data.nested as { at: Timestamp; keep: number }).at).toBeInstanceOf(Timestamp);
    expect((data.nested as { keep: number }).keep).toBe(1);
  });

  it("increment() adds instead of storing {operand}", async () => {
    const ref = getFirestore().collection("minified").doc("inc");
    await ref.set({ n: 1 });
    await ref.update({ n: asMinified(FieldValue.increment(5)) });
    expect((await ref.get()).data()!.n).toBe(6);
    await ref.update({ n: asMinified(FieldValue.increment(-2)) });
    expect((await ref.get()).data()!.n).toBe(4);
  });

  it("arrayUnion()/arrayRemove() edit the array instead of storing {elements}", async () => {
    const ref = getFirestore().collection("minified").doc("arr");
    await ref.set({ tags: ["a"] });
    await ref.update({ tags: asMinified(FieldValue.arrayUnion("b", "c", "b")) });
    expect((await ref.get()).data()!.tags).toEqual(["a", "b", "c"]);
    await ref.update({ tags: asMinified(FieldValue.arrayRemove("a")) });
    expect((await ref.get()).data()!.tags).toEqual(["b", "c"]);
  });

  it("delete() removes the field instead of blanking it to {}", async () => {
    const ref = getFirestore().collection("minified").doc("del");
    await ref.set({ keep: 1, drop: "x" });
    await ref.update({ drop: asMinified(FieldValue.delete()) });
    expect((await ref.get()).data()).toEqual({ keep: 1 });
  });

  it("a FieldValue the shim cannot classify throws rather than being stored as data", async () => {
    // No known methodName, no matching class name: the shape a future SDK
    // sentinel would have. Silently storing its innards is what made the
    // original bug survive a production cutover.
    const unknownSentinel = Object.create(FieldValue.prototype) as object;
    const ref = getFirestore().collection("minified").doc("unknown");
    await expect(ref.set({ x: unknownSentinel })).rejects.toThrow(/unrecognised FieldValue sentinel/);
  });
});
