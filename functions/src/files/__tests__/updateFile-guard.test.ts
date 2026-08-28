/**
 * updateFile writes metadata, and only metadata.
 *
 * It used to accept the extracted figures too, on a path that consolidated
 * the line items into the total — a derivation written as if a person had
 * ruled on it, with no provenance stamp a re-extraction would respect, and
 * none of the reconciliation re-derivation #203 introduced. Its copy loop
 * also forwarded EVERY key of the payload into the Firestore update, so a
 * caller could write any field on their own file record — a provenance
 * stamp, a derived classification, a review flag. Both doors are closed:
 * figure fields are refused towards updateFileExtractedFields, and unknown
 * keys are refused outright.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestFile } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class MockTimestamp {
    constructor(private readonly date: Date) {}
    static fromDate(d: Date) {
      return new MockTimestamp(d);
    }
    static now() {
      return new MockTimestamp(new Date("2026-08-28T12:00:00Z"));
    }
    toDate() {
      return this.date;
    }
  }

  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: {
      serverTimestamp: () => new Date("2026-08-28T12:00:00Z"),
    },
    Timestamp: MockTimestamp,
  };
});

const { updateFileCallable } = await import("../updateFile");

const userId = "user-1";

function call(data: Record<string, unknown>) {
  return (updateFileCallable as unknown as {
    run: (r: never) => Promise<{ success: boolean }>;
  }).run({ data: { fileId: "f-1", data }, auth: { uid: userId } } as never);
}

const file = () => store.getDoc("files", "f-1") as Record<string, unknown>;

beforeEach(() => {
  store.clear();
  store.setDoc(
    "files",
    "f-1",
    createTestFile({ userId, fileName: "beleg.pdf", extractedAmount: 8100 })
  );
});

describe("updateFileCallable", () => {
  it("still writes the metadata it exists for", async () => {
    const result = await call({ fileName: "renamed.pdf" });

    expect(result.success).toBe(true);
    expect(file().fileName).toBe("renamed.pdf");
  });

  it("refuses the extracted figures towards updateFileExtractedFields", async () => {
    await expect(call({ extractedAmount: 9000 })).rejects.toThrow(
      /updateFileExtractedFields/
    );
    await expect(
      call({ extractedLineItems: [{ description: "row", amount: 9000, vatAmount: 1500, vatPercent: 20 }] })
    ).rejects.toThrow(/updateFileExtractedFields/);

    // Refused loudly means refused entirely — nothing half-written.
    expect(file().extractedAmount).toBe(8100);
    expect(file().fileName).toBe("beleg.pdf");
  });

  it("refuses a key outside its contract instead of forwarding it", async () => {
    await expect(
      call({ extractionCorrectedFields: { amount: { _seconds: 1 } } })
    ).rejects.toThrow(/does not write/);
    expect(file().extractionCorrectedFields).toBeUndefined();
  });

  it("keeps the #233 direction path: sets, stamps, and reclassifies", async () => {
    await call({ invoiceDirection: "incoming" });

    expect(file().invoiceDirection).toBe("incoming");
    expect(Object.keys(file().extractionCorrectedFields as object)).toEqual([
      "invoiceDirection",
    ]);
  });
});
