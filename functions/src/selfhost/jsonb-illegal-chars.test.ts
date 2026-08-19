/**
 * Characters that are legal in JSON and illegal inside a Postgres `jsonb`
 * string (fork #138).
 *
 * These run against embedded PGlite, i.e. real Postgres, so each case fails
 * with `unsupported Unicode escape sequence` without the sanitiser — the write
 * is what breaks, not the reader.
 *
 * Found live: one PDF of 325 whose text layer carried a NUL byte became
 * permanently unextractable, every retry hitting the same byte, and reporting
 * itself as `EXTRACTION_FAILED` as though the model or the document were at
 * fault.
 */

import { describe, it, expect } from "vitest";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";

const NUL = "\u0000";
const FFFD = "\uFFFD";

describe("jsonb string sanitising", () => {
  it("a NUL costs its own byte, not the whole document", async () => {
    await __resetFirestoreShim();
    const ref = getFirestore().collection("nultest").doc("a");
    await ref.set({
      extractedText: `Rechnung${NUL} Nr. 5`,
      amount: 31800,
    });
    const data = (await ref.get()).data();
    expect(data?.extractedText).toBe("Rechnung Nr. 5");
    // The rest of the record survives intact — that is the point of stripping
    // at the boundary rather than failing the write.
    expect(data?.amount).toBe(31800);
  });

  it("reaches strings nested in objects and arrays, and field names too", async () => {
    const ref = getFirestore().collection("nultest").doc("b");
    await ref.set({
      raw: { lines: [`a${NUL}b`, { note: `c${NUL}d` }] },
      [`key${NUL}name`]: "plain",
    });
    const data = (await ref.get()).data() as Record<string, unknown>;
    expect(data.raw).toEqual({ lines: ["ab", { note: "cd" }] });
    expect(data.keyname).toBe("plain");
  });

  it("a key that sanitises into __proto__ is dropped, not stored", async () => {
    // The sink guard tests the key that is actually written, so a NUL inside
    // the name cannot carry it past three literal comparisons and land back on
    // "__proto__" at the point of assignment.
    //
    // This pins the outcome, not the ordering: with the old ordering the
    // polluted object was the encoder's own temporary, which never escapes and
    // is serialised by own-property enumeration, so the stored record looked
    // identical. That is why the reorder is worth doing anyway — the guard
    // should not depend on a downstream detail for its correctness.
    const ref = getFirestore().collection("nultest").doc("proto");
    await ref.set({ [`__proto__${NUL}`]: { polluted: true }, keep: 1 });
    const data = (await ref.get()).data() as Record<string, unknown>;
    expect(data.keep).toBe(1);
    // Dropped, not stored under a cleaned-up name, and no prototype touched.
    expect(Object.prototype.hasOwnProperty.call(data, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("an unpaired surrogate becomes U+FFFD rather than aborting the write", async () => {
    const ref = getFirestore().collection("nultest").doc("c");
    // A multi-byte character truncated mid-pair by an upstream buffer.
    await ref.set({ extractedText: "Betrag \uD83D and \uDE00 done" });
    expect((await ref.get()).data()?.extractedText).toBe(
      `Betrag ${FFFD} and ${FFFD} done`,
    );
  });

  it("leaves a well-formed pair and ordinary control characters alone", async () => {
    const ref = getFirestore().collection("nultest").doc("d");
    // Tab and newline are legal in a jsonb string; dropping them would mangle
    // every extracted text layer for no reason.
    const text = "Zeile 1\n\tPos 2 \u{1F600} äöü";
    await ref.set({ extractedText: text });
    expect((await ref.get()).data()?.extractedText).toBe(text);
  });
});
