/**
 * Prototype-pollution hardening (CodeQL findings on the spike, 2026-07-20):
 * user-controlled field names must never write through "__proto__" & co.
 * The server shim rejects reserved __...__ names (parity with
 * firebase-admin — also asserted against the emulator in
 * src/test/firestore-parity.test.ts); the wire codec refuses the unsafe
 * trio for the client data plane.
 */

import { describe, it, expect } from "vitest";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";
import { decodeWire, WireError } from "./wire-values";

describe("firestore shim field-name hardening", () => {
  it("set() rejects reserved and prototype-polluting field names", async () => {
    await __resetFirestoreShim();
    const ref = getFirestore().collection("polltest").doc("a");
    await expect(ref.set({ ["__proto__"]: { polluted: true } })).rejects.toThrow(/invalid field name/);
    await expect(ref.set({ nested: { ["__evil__"]: 1 } })).rejects.toThrow(/invalid field name/);
    await expect(ref.set({ ["constructor"]: 1 })).rejects.toThrow(/invalid field name/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("update() rejects polluting dot-paths and leaves the doc untouched", async () => {
    const ref = getFirestore().collection("polltest").doc("b");
    await ref.set({ ok: 1 });
    await expect(ref.update({ ["__proto__.polluted"]: true })).rejects.toThrow(/invalid field name/);
    await expect(ref.update({ ["nested.__proto__.polluted"]: true })).rejects.toThrow(/invalid field name/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((await ref.get()).data()).toEqual({ ok: 1 });
  });
});

describe("wire codec field-name hardening", () => {
  it("decodeWire refuses the unsafe trio (\"__proto__\" dies at the __ tag check)", () => {
    // JSON.parse creates OWN "__proto__" properties, which is exactly how a
    // hostile client payload arrives at the data plane.
    expect(() => decodeWire(JSON.parse('{"__proto__": {"polluted": true}}'), true)).toThrow(WireError);
    expect(() => decodeWire(JSON.parse('{"constructor": 1}'), true)).toThrow(WireError);
    expect(() => decodeWire(JSON.parse('{"a": {"prototype": 1}}'), false)).toThrow(WireError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
